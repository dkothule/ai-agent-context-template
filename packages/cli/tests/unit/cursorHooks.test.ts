import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { installCursorHooks, removeCursorHooks } from '../../src/core/cursorHooks.js';

let tmpDir: string;
let cursorDir: string;
let templateCursorDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), 'ai-context-cursor-test-' + randomBytes(6).toString('hex'));
  cursorDir = join(tmpDir, '.cursor');
  templateCursorDir = join(tmpDir, '_template_cursor');
  // Simulate copyTemplates already having put the scripts in .cursor/hooks/
  await mkdir(join(cursorDir, 'hooks'), { recursive: true });
  await writeFile(join(cursorDir, 'hooks', 'pre-compact.sh'), '#!/bin/bash\nexit 0\n');
  await writeFile(join(cursorDir, 'hooks', 'session-log-check.sh'), '#!/bin/bash\nexit 0\n');
  await writeFile(join(cursorDir, 'hooks', 'context-reminder.sh'), '#!/bin/bash\nexit 0\n');
  await mkdir(templateCursorDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

type Entry = { command: string };
const hasScript = (arr: Entry[] | undefined, script: string): boolean =>
  Array.isArray(arr) && arr.some((e) => e.command?.includes(script));

describe('installCursorHooks — fresh install', () => {
  it('writes a fresh hooks.json with preCompact and sessionStart', async () => {
    const result = await installCursorHooks(templateCursorDir, tmpDir, false);
    expect(result.configMerged).toBe(true);
    expect(result.eventsMerged.sort()).toEqual(['preCompact', 'sessionEnd', 'sessionStart']);
    expect(result.hooksCopied).toBe(true);

    const config = JSON.parse(await readFile(join(cursorDir, 'hooks.json'), 'utf8'));
    expect(config.version).toBe(1);
    expect(hasScript(config.hooks.preCompact, 'pre-compact.sh')).toBe(true);
    // sessionEnd now carries the session-end capture hook, not the retired reminder.
    expect(hasScript(config.hooks.sessionEnd, 'session-end-capture.sh')).toBe(true);
    expect(hasScript(config.hooks.sessionEnd, 'session-log-check.sh')).toBe(false);
    expect(hasScript(config.hooks.sessionStart, 'context-reminder.sh')).toBe(true);
    expect(config.hooks.preCompact[0].command).toContain('git rev-parse --show-toplevel');
  });

  it('reports hooksCopied=false if scripts are not present', async () => {
    await rm(join(cursorDir, 'hooks'), { recursive: true, force: true });
    const result = await installCursorHooks(templateCursorDir, tmpDir, false);
    // hooks.json is still written, but scripts were not pre-copied by copyTemplates
    expect(result.configMerged).toBe(true);
    expect(result.hooksCopied).toBe(false);
  });
});

describe('installCursorHooks — upgrade / idempotency', () => {
  it('is idempotent: a second run returns merged=false and leaves the file unchanged', async () => {
    await installCursorHooks(templateCursorDir, tmpDir, false);
    const first = await readFile(join(cursorDir, 'hooks.json'), 'utf8');

    const second = await installCursorHooks(templateCursorDir, tmpDir, false);
    expect(second.configMerged).toBe(false);
    expect(second.configSkipReason).toBe('AI Context hooks already present');

    const after = await readFile(join(cursorDir, 'hooks.json'), 'utf8');
    expect(after).toBe(first);
  });

  it('upgrades from a partial hooks.json by adding missing events and refreshing old commands', async () => {
    // Pre-existing config has only sessionEnd, using the older relative command
    // shape from pre-release v1.2 builds.
    const existing = {
      version: 1,
      hooks: {
        sessionEnd: [{ command: 'bash .cursor/hooks/session-log-check.sh' }],
      },
    };
    await writeFile(join(cursorDir, 'hooks.json'), JSON.stringify(existing, null, 2));

    const result = await installCursorHooks(templateCursorDir, tmpDir, false);
    expect(result.configMerged).toBe(true);
    expect(result.eventsMerged.sort()).toEqual(['preCompact', 'sessionEnd', 'sessionStart']);

    const merged = JSON.parse(await readFile(join(cursorDir, 'hooks.json'), 'utf8'));
    expect(hasScript(merged.hooks.sessionEnd, 'session-end-capture.sh')).toBe(true);
    expect(hasScript(merged.hooks.sessionEnd, 'session-log-check.sh')).toBe(false);
    expect(merged.hooks.preCompact).toHaveLength(1);
    expect(merged.hooks.sessionStart).toHaveLength(1);
  });

  it('updates older AI Context relative commands to git-root-resolved commands', async () => {
    const existing = {
      version: 1,
      hooks: {
        preCompact: [{ command: 'bash .cursor/hooks/pre-compact.sh' }],
        sessionEnd: [{ command: 'bash .cursor/hooks/session-log-check.sh' }],
        sessionStart: [{ command: 'bash .cursor/hooks/context-reminder.sh' }],
      },
    };
    await writeFile(join(cursorDir, 'hooks.json'), JSON.stringify(existing, null, 2));

    const result = await installCursorHooks(templateCursorDir, tmpDir, false);
    expect(result.configMerged).toBe(true);
    expect(result.eventsMerged.sort()).toEqual(['preCompact', 'sessionEnd', 'sessionStart']);

    const merged = JSON.parse(await readFile(join(cursorDir, 'hooks.json'), 'utf8'));
    expect(merged.hooks.preCompact).toHaveLength(1);
    expect(merged.hooks.preCompact[0].command).toContain('git rev-parse --show-toplevel');
    expect(hasScript(merged.hooks.sessionEnd, 'session-end-capture.sh')).toBe(true);
    expect(merged.hooks.sessionStart[0].command).toContain('git rev-parse --show-toplevel');
  });

  it('preserves user-owned hooks in the same events and adds ours additively', async () => {
    const userOwned = {
      version: 1,
      hooks: {
        sessionEnd: [{ command: 'bash scripts/my-session-end.sh' }],
        beforeShellExecution: [{ command: 'bash scripts/audit-shell.sh' }],
      },
    };
    await writeFile(join(cursorDir, 'hooks.json'), JSON.stringify(userOwned, null, 2));

    const result = await installCursorHooks(templateCursorDir, tmpDir, false);
    expect(result.configMerged).toBe(true);

    const merged = JSON.parse(await readFile(join(cursorDir, 'hooks.json'), 'utf8'));
    expect(merged.hooks.beforeShellExecution).toEqual(userOwned.hooks.beforeShellExecution);
    // User handler preserved, plus the capture hook added additively.
    expect(merged.hooks.sessionEnd).toHaveLength(2);
    expect(hasScript(merged.hooks.sessionEnd, 'session-end-capture.sh')).toBe(true);
    expect(hasScript(merged.hooks.sessionEnd, 'my-session-end.sh')).toBe(true);
    expect(hasScript(merged.hooks.sessionEnd, 'session-log-check.sh')).toBe(false);
  });

  it('dry-run does not write anything', async () => {
    const existing = { version: 1, hooks: {} };
    await writeFile(join(cursorDir, 'hooks.json'), JSON.stringify(existing));

    const result = await installCursorHooks(templateCursorDir, tmpDir, true);
    expect(result.configMerged).toBe(true);

    const raw = await readFile(join(cursorDir, 'hooks.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual(existing);
  });

  it('skips on invalid JSON without throwing', async () => {
    await writeFile(join(cursorDir, 'hooks.json'), '{ not valid json');
    const result = await installCursorHooks(templateCursorDir, tmpDir, false);
    expect(result.configMerged).toBe(false);
    expect(result.configSkipReason).toBe('hooks.json is not valid JSON');
  });
});

describe('removeCursorHooks', () => {
  it('removes all three AI Context entries and deletes the stub file (only had our content)', async () => {
    await installCursorHooks(templateCursorDir, tmpDir, false);

    const removed = await removeCursorHooks(tmpDir, false);
    expect(removed).toBe(true);

    // After uninstall on a fresh install, the stub `{ "version": 1 }` shell
    // is meaningless on its own, so the file should be deleted.
    expect(existsSync(join(cursorDir, 'hooks.json'))).toBe(false);
  });

  it('preserves the file when user has non-stub top-level keys', async () => {
    // Simulate a user-customised hooks.json that ALSO had our hooks merged in.
    await installCursorHooks(templateCursorDir, tmpDir, false);
    const config = JSON.parse(await readFile(join(cursorDir, 'hooks.json'), 'utf8'));
    config.permissions = { allow: ['Bash'] };
    await writeFile(join(cursorDir, 'hooks.json'), JSON.stringify(config, null, 2));

    const removed = await removeCursorHooks(tmpDir, false);
    expect(removed).toBe(true);

    // File should still exist — the user has their own top-level config.
    expect(existsSync(join(cursorDir, 'hooks.json'))).toBe(true);
    const after = JSON.parse(await readFile(join(cursorDir, 'hooks.json'), 'utf8'));
    expect(after.hooks).toBeUndefined();
    expect(after.permissions).toEqual({ allow: ['Bash'] });
  });

  it('leaves user-owned entries in the same events intact', async () => {
    const settings = {
      version: 1,
      hooks: {
        sessionEnd: [
          { command: 'bash scripts/my-session-end.sh' },
          { command: 'bash .cursor/hooks/session-log-check.sh' },
        ],
        preCompact: [{ command: 'bash .cursor/hooks/pre-compact.sh' }],
      },
    };
    await writeFile(join(cursorDir, 'hooks.json'), JSON.stringify(settings, null, 2));

    const removed = await removeCursorHooks(tmpDir, false);
    expect(removed).toBe(true);

    const updated = JSON.parse(await readFile(join(cursorDir, 'hooks.json'), 'utf8'));
    expect(updated.hooks.sessionEnd).toEqual([{ command: 'bash scripts/my-session-end.sh' }]);
    expect(updated.hooks.preCompact).toBeUndefined();
  });

  it('returns false when no AI Context hooks are present', async () => {
    await writeFile(join(cursorDir, 'hooks.json'), JSON.stringify({ version: 1, hooks: {} }));
    expect(await removeCursorHooks(tmpDir, false)).toBe(false);
  });

  it('returns false if hooks.json does not exist', async () => {
    expect(existsSync(join(cursorDir, 'hooks.json'))).toBe(false);
    expect(await removeCursorHooks(tmpDir, false)).toBe(false);
  });
});
