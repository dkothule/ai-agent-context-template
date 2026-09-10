import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { installClaudeHooks, removeHookFromSettings } from '../../src/core/claudeHooks.js';

let tmpDir: string;
let claudeDir: string;
let templateClaudeDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), 'ai-context-test-' + randomBytes(6).toString('hex'));
  claudeDir = join(tmpDir, '.claude');
  templateClaudeDir = join(tmpDir, '_template_claude');
  await mkdir(claudeDir, { recursive: true });
  await mkdir(join(templateClaudeDir, 'hooks'), { recursive: true });
  await writeFile(join(templateClaudeDir, 'hooks', 'session-log-check.sh'), '#!/bin/bash\necho ok\n');
  await writeFile(join(templateClaudeDir, 'hooks', 'pre-compact.sh'), '#!/bin/bash\nexit 0\n');
  await writeFile(join(templateClaudeDir, 'hooks', 'context-reminder.sh'), '#!/bin/bash\nexit 0\n');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

type Entry = { matcher?: string; hooks: Array<{ command: string }> };
const findEntry = (arr: Entry[] | undefined, script: string): Entry | undefined =>
  arr?.find((e) => e.hooks?.some((h) => h.command?.includes(script)));

describe('installClaudeHooks — fresh install', () => {
  it('installs PreCompact(manual/auto) + SessionStart(startup/resume/compact) into a missing settings.json', async () => {
    const result = await installClaudeHooks(templateClaudeDir, tmpDir, false);
    expect(result.settingsMerged).toBe(true);

    const merged = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8'));

    expect(findEntry(merged.hooks.Stop, 'session-log-check.sh')).toBeUndefined();
    expect(merged.hooks.Stop).toBeUndefined();
    expect(findEntry(merged.hooks.PreCompact, 'pre-compact.sh')).toBeDefined();
    expect(merged.hooks.PreCompact.some((e: Entry) => e.matcher === 'manual')).toBe(true);
    expect(merged.hooks.PreCompact.some((e: Entry) => e.matcher === 'auto')).toBe(true);
    expect(findEntry(merged.hooks.SessionStart, 'context-reminder.sh')).toBeDefined();
    expect(merged.hooks.SessionStart[0].matcher).toBe('startup|resume|compact');
  });

  it('merges into settings.json that has only permissions', async () => {
    const settings = { permissions: { allow: ['Bash'] } };
    await writeFile(join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2));

    const result = await installClaudeHooks(templateClaudeDir, tmpDir, false);
    expect(result.settingsMerged).toBe(true);

    const merged = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8'));
    expect(merged.permissions).toEqual({ allow: ['Bash'] });
    expect(merged.hooks.Stop).toBeUndefined();
    expect(merged.hooks.PreCompact).toBeDefined();
    expect(merged.hooks.SessionStart).toBeDefined();
  });
});

describe('installClaudeHooks — upgrade / idempotency', () => {
  it('is idempotent: running twice yields the same settings', async () => {
    await installClaudeHooks(templateClaudeDir, tmpDir, false);
    const first = await readFile(join(claudeDir, 'settings.json'), 'utf8');

    const second = await installClaudeHooks(templateClaudeDir, tmpDir, false);
    expect(second.settingsMerged).toBe(false);
    expect(second.settingsSkipReason).toBe('AI Context hooks already present');

    const after = await readFile(join(claudeDir, 'settings.json'), 'utf8');
    expect(after).toBe(first);
  });

  it('upgrades from a v1.0 install (only Stop) by adding PreCompact + SessionStart', async () => {
    const v1 = {
      hooks: {
        Stop: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: 'bash .claude/hooks/session-log-check.sh', timeout: 5000 }],
          },
        ],
      },
    };
    await writeFile(join(claudeDir, 'settings.json'), JSON.stringify(v1, null, 2));

    const result = await installClaudeHooks(templateClaudeDir, tmpDir, false);
    expect(result.settingsMerged).toBe(true);

    const merged = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8'));
    expect(merged.hooks.Stop).toBeUndefined();
    expect(merged.hooks.Stop).toBeUndefined();
    expect(merged.hooks.PreCompact).toHaveLength(2);
    expect(merged.hooks.SessionStart).toHaveLength(1);
  });

  it('updates older AI Context relative commands to project-root-resolved commands', async () => {
    const existing = {
      hooks: {
        Stop: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: 'bash .claude/hooks/session-log-check.sh', timeout: 5000 }],
          },
        ],
        PreCompact: [
          {
            matcher: 'manual',
            hooks: [{ type: 'command', command: 'bash .claude/hooks/pre-compact.sh', timeout: 5000 }],
          },
          {
            matcher: 'auto',
            hooks: [{ type: 'command', command: 'bash .claude/hooks/pre-compact.sh', timeout: 10000 }],
          },
        ],
        SessionStart: [
          {
            matcher: 'compact',
            hooks: [{ type: 'command', command: 'bash .claude/hooks/context-reminder.sh', timeout: 5000 }],
          },
        ],
      },
    };
    await writeFile(join(claudeDir, 'settings.json'), JSON.stringify(existing, null, 2));

    const result = await installClaudeHooks(templateClaudeDir, tmpDir, false);
    expect(result.settingsMerged).toBe(true);
    expect(result.eventsMerged.sort()).toEqual(['PreCompact', 'SessionEnd', 'SessionStart', 'Stop']);

    const merged = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8'));
    expect(merged.hooks.Stop).toBeUndefined();
    expect(merged.hooks.PreCompact[0].hooks[0].command).toContain('CLAUDE_PROJECT_DIR');
    expect(merged.hooks.PreCompact[1].hooks[0].command).toContain('CLAUDE_PROJECT_DIR');
    expect(merged.hooks.SessionStart[0].hooks[0].command).toContain('CLAUDE_PROJECT_DIR');
  });

  it('preserves user-owned hooks in foreign events and adds ours additively', async () => {
    const userOwned = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'bash scripts/my-prehook.sh' }] },
        ],
        Stop: [
          { matcher: '', hooks: [{ type: 'command', command: 'bash scripts/my-stop.sh' }] },
        ],
      },
    };
    await writeFile(join(claudeDir, 'settings.json'), JSON.stringify(userOwned, null, 2));

    const result = await installClaudeHooks(templateClaudeDir, tmpDir, false);
    expect(result.settingsMerged).toBe(true);

    const merged = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8'));
    expect(merged.hooks.PreToolUse).toEqual(userOwned.hooks.PreToolUse);
    expect(merged.hooks.Stop).toHaveLength(1); // user only
    expect(findEntry(merged.hooks.Stop, 'my-stop.sh')).toBeDefined();
    expect(findEntry(merged.hooks.Stop, 'session-log-check.sh')).toBeUndefined();
  });

  it('dry-run does not write anything', async () => {
    const settings = { permissions: {} };
    await writeFile(join(claudeDir, 'settings.json'), JSON.stringify(settings));

    await installClaudeHooks(templateClaudeDir, tmpDir, true);
    const raw = await readFile(join(claudeDir, 'settings.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual(settings);
  });
});

describe('removeHookFromSettings', () => {
  it('removes all three AI Context hooks and deletes the stub file when nothing else remains', async () => {
    await installClaudeHooks(templateClaudeDir, tmpDir, false);

    const removed = await removeHookFromSettings(tmpDir, false);
    expect(removed).toBe(true);

    // On a fresh install we wrote `{ "hooks": {...} }`; after removal the
    // file is purely our stub and should be deleted.
    const { existsSync } = await import('fs');
    expect(existsSync(join(claudeDir, 'settings.json'))).toBe(false);
  });

  it('preserves settings.json when user-owned keys (e.g. permissions) remain', async () => {
    await writeFile(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash'] } }),
    );
    await installClaudeHooks(templateClaudeDir, tmpDir, false);

    const removed = await removeHookFromSettings(tmpDir, false);
    expect(removed).toBe(true);

    const { existsSync } = await import('fs');
    expect(existsSync(join(claudeDir, 'settings.json'))).toBe(true);

    const updated = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8'));
    expect(updated.hooks).toBeUndefined();
    expect(updated.permissions).toEqual({ allow: ['Bash'] });
  });

  it('leaves user-owned entries in the same events intact', async () => {
    const userStop = { matcher: '', hooks: [{ type: 'command', command: 'bash scripts/my-stop.sh' }] };
    const settings = {
      hooks: {
        Stop: [
          userStop,
          { matcher: '', hooks: [{ type: 'command', command: 'bash .claude/hooks/session-log-check.sh' }] },
        ],
        PreCompact: [
          { matcher: 'manual', hooks: [{ type: 'command', command: 'bash .claude/hooks/pre-compact.sh' }] },
        ],
      },
    };
    await writeFile(join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2));

    const removed = await removeHookFromSettings(tmpDir, false);
    expect(removed).toBe(true);

    const updated = JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8'));
    expect(updated.hooks.Stop).toEqual([userStop]);
    expect(updated.hooks.PreCompact).toBeUndefined();
  });

  it('returns false if no AI Context hook is present', async () => {
    await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({ permissions: {} }));
    expect(await removeHookFromSettings(tmpDir, false)).toBe(false);
  });

  it('returns false if settings.json does not exist', async () => {
    expect(await removeHookFromSettings(tmpDir, false)).toBe(false);
  });
});
