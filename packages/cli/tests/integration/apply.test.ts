import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { runInstall } from '../../src/core/install.js';
import { ALL_AGENTS } from '../../src/core/copyTemplates.js';
import { readManifest, writeManifest } from '../../src/core/manifest.js';
import type { Manifest } from '../../src/core/manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_MANIFEST = join(__dirname, '..', '..', 'src', 'templates', 'ai-context', 'manifest.json');
async function currentTemplateVersion(): Promise<string> {
  return JSON.parse(await readFile(TEMPLATE_MANIFEST, 'utf8')).version;
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), 'ai-context-int-' + randomBytes(6).toString('hex'));
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('runInstall — fresh install', () => {
  it('creates .ai-context/ with manifest.json', async () => {
    const result = await runInstall({ targetDir: tmpDir, agents: ALL_AGENTS });
    expect(result.applyMode).toBe('fresh-install');
    expect(existsSync(join(tmpDir, '.ai-context', 'manifest.json'))).toBe(true);

    const manifest = await readManifest(join(tmpDir, '.ai-context'));
    expect(manifest).not.toBeNull();
    expect(manifest!.version).toBe(await currentTemplateVersion());
    expect(manifest!.apply_mode).toBe('fresh-install');
    expect(manifest!.managed_by).toMatch(/^npm:.*ai-context@[\d.]+$/);
  });

  it('copies agent adapter files', async () => {
    await runInstall({ targetDir: tmpDir, agents: ALL_AGENTS });
    expect(existsSync(join(tmpDir, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(tmpDir, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(tmpDir, '.cursor', 'rules', 'main.mdc'))).toBe(true);
  });

  it('installs only selected agents', async () => {
    await runInstall({ targetDir: tmpDir, agents: ['claude'] });
    expect(existsSync(join(tmpDir, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(tmpDir, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(tmpDir, '.cursor'))).toBe(false);
  });

  it('creates a backup directory', async () => {
    const result = await runInstall({ targetDir: tmpDir, agents: ALL_AGENTS });
    expect(result.backupDir).not.toBeNull();
    expect(existsSync(result.backupDir!)).toBe(true);
  });

  it('dry-run writes nothing', async () => {
    const result = await runInstall({ targetDir: tmpDir, agents: ALL_AGENTS, dryRun: true });
    expect(result.applyMode).toBe('fresh-install');
    expect(existsSync(join(tmpDir, '.ai-context'))).toBe(false);
    expect(result.backupDir).toBeNull();
  });
});

describe('runInstall — upgrade', () => {
  async function installOldVersion(dir: string): Promise<void> {
    // Simulate an existing installation at v0.5.0 with a project-owned file
    const contextDir = join(dir, '.ai-context');
    await mkdir(join(contextDir, 'sessions'), { recursive: true });
    await mkdir(join(contextDir, 'standards'), { recursive: true });

    const oldManifest: Manifest = {
      name: 'ai-context',
      version: '0.5.0',
      schema_version: 4,
      managed_by: 'scripts/ai-context.sh',
      installed_at: '2026-01-01T00:00:00.000Z',
      apply_mode: 'fresh-install',
      agents_installed: null,
      configured_cli: null,
      previous_version: null,
      previous_schema_version: null,
    };
    await writeManifest(contextDir, oldManifest);
    // Project-owned file
    await writeFile(join(contextDir, 'project.overview.md'), '# My Project\nCustom content');
  }

  it('detects upgrade mode and preserves project-owned files', async () => {
    await installOldVersion(tmpDir);

    const result = await runInstall({ targetDir: tmpDir, agents: ALL_AGENTS });
    expect(result.applyMode).toBe('upgrade');
    expect(result.previousVersion).toBe('0.5.0');

    // Project-owned file should be restored
    const overview = await readFile(join(tmpDir, '.ai-context', 'project.overview.md'), 'utf8');
    expect(overview).toContain('Custom content');
  });

  it('writes upgrade apply_mode to new manifest', async () => {
    await installOldVersion(tmpDir);
    await runInstall({ targetDir: tmpDir, agents: ALL_AGENTS });

    const manifest = await readManifest(join(tmpDir, '.ai-context'));
    expect(manifest!.apply_mode).toBe('upgrade');
    expect(manifest!.previous_version).toBe('0.5.0');
    expect(manifest!.version).toBe(await currentTemplateVersion());
  });

  it('preserves configured_cli across an upgrade', async () => {
    await installOldVersion(tmpDir);
    const contextDir = join(tmpDir, '.ai-context');
    // Simulate a prior CLI selection persisted by setup.
    const existing = await readManifest(contextDir);
    await writeManifest(contextDir, { ...existing!, configured_cli: 'codex' });

    await runInstall({ targetDir: tmpDir, agents: ALL_AGENTS });

    const manifest = await readManifest(contextDir);
    expect(manifest!.configured_cli).toBe('codex');
  });

  it('leaves configured_cli null on a fresh install', async () => {
    await runInstall({ targetDir: tmpDir, agents: ALL_AGENTS });
    const manifest = await readManifest(join(tmpDir, '.ai-context'));
    expect(manifest!.configured_cli).toBeNull();
  });
});

describe('runInstall — reapply', () => {
  it('detects reapply when version matches', async () => {
    // Install once
    await runInstall({ targetDir: tmpDir, agents: ALL_AGENTS });
    // Install again
    const result = await runInstall({ targetDir: tmpDir, agents: ALL_AGENTS });
    expect(result.applyMode).toBe('reapply');
  });
});

describe('runInstall — legacy upgrade', () => {
  it('detects legacy-upgrade for unversioned .ai-context/', async () => {
    // Old-style: .ai-context/ exists but no manifest
    const contextDir = join(tmpDir, '.ai-context');
    await mkdir(contextDir, { recursive: true });
    await writeFile(join(contextDir, 'project.overview.md'), 'Legacy project');

    const result = await runInstall({ targetDir: tmpDir, agents: ALL_AGENTS });
    expect(result.applyMode).toBe('legacy-upgrade');
  });
});

describe('runInstall — .gitignore', () => {
  it('adds entries when gitignore=true', async () => {
    await runInstall({ targetDir: tmpDir, agents: ['claude'], gitignore: true });
    const content = await readFile(join(tmpDir, '.gitignore'), 'utf8');
    expect(content).toContain('# ai-context');
    expect(content).toContain('.ai-context/sessions/');
  });

  it('does not modify .gitignore by default', async () => {
    await runInstall({ targetDir: tmpDir, agents: ['claude'] });
    expect(existsSync(join(tmpDir, '.gitignore'))).toBe(false);
  });
});

describe('runInstall — hooks', () => {
  it('merges hooks into existing settings.json', async () => {
    await mkdir(join(tmpDir, '.claude'), { recursive: true });
    await writeFile(
      join(tmpDir, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash'] } }, null, 2),
    );

    const result = await runInstall({ targetDir: tmpDir, agents: ['claude'] });
    expect(result.hooksMerged).toBe(true);

    const raw = await readFile(join(tmpDir, '.claude', 'settings.json'), 'utf8');
    const settings = JSON.parse(raw);
    expect(settings.hooks).toBeDefined();
    expect(settings.permissions).toEqual({ allow: ['Bash'] }); // preserved
  });

  it('does NOT install Claude hooks when claude agent is not selected', async () => {
    // Symmetry with the cursor / codex tests below — agent-specific hook
    // installation should be gated by the selected agents list.
    const result = await runInstall({ targetDir: tmpDir, agents: ['cursor'] });

    expect(result.hooksMerged).toBe(false);
    expect(existsSync(join(tmpDir, '.claude', 'hooks'))).toBe(false);
    expect(existsSync(join(tmpDir, '.claude', 'settings.json'))).toBe(false);
    // Cursor was selected, so its files should be present.
    expect(existsSync(join(tmpDir, '.cursor', 'hooks.json'))).toBe(true);
  });
});

describe('runInstall — cursor hooks', () => {
  it('installs .cursor/hooks.json + scripts when cursor agent selected', async () => {
    const result = await runInstall({ targetDir: tmpDir, agents: ['cursor'] });
    expect(result.cursorHooksMerged).toBe(true);
    expect(result.cursorHooksEventsMerged?.sort()).toEqual(['preCompact', 'sessionEnd', 'sessionStart']);

    expect(existsSync(join(tmpDir, '.cursor', 'rules', 'main.mdc'))).toBe(true);
    expect(existsSync(join(tmpDir, '.cursor', 'hooks', 'pre-compact.sh'))).toBe(true);
    expect(existsSync(join(tmpDir, '.cursor', 'hooks', 'session-end-capture.sh'))).toBe(true);
    // Retired in 1.2.2 — the reminder moved to session start, capture replaced it.
    expect(existsSync(join(tmpDir, '.cursor', 'hooks', 'session-log-check.sh'))).toBe(false);
    expect(existsSync(join(tmpDir, '.cursor', 'hooks', 'context-reminder.sh'))).toBe(true);

    const config = JSON.parse(await readFile(join(tmpDir, '.cursor', 'hooks.json'), 'utf8'));
    expect(config.version).toBe(1);
    expect(Object.keys(config.hooks).sort()).toEqual(['preCompact', 'sessionEnd', 'sessionStart']);
    expect(config.hooks.preCompact[0].command).toContain('git rev-parse --show-toplevel');
    expect(config.hooks.preCompact[0].command).toContain('.cursor/hooks/pre-compact.sh');
  });

  it('does not install cursor hooks when cursor agent not selected', async () => {
    const result = await runInstall({ targetDir: tmpDir, agents: ['claude'] });
    expect(result.cursorHooksMerged).toBeUndefined();
    expect(existsSync(join(tmpDir, '.cursor', 'hooks.json'))).toBe(false);
    expect(existsSync(join(tmpDir, '.cursor', 'hooks'))).toBe(false);
  });

  it('cursor hook install is idempotent on reapply', async () => {
    await runInstall({ targetDir: tmpDir, agents: ['cursor'] });
    const first = await readFile(join(tmpDir, '.cursor', 'hooks.json'), 'utf8');

    const second = await runInstall({ targetDir: tmpDir, agents: ['cursor'] });
    expect(second.cursorHooksMerged).toBe(false);

    const after = await readFile(join(tmpDir, '.cursor', 'hooks.json'), 'utf8');
    expect(after).toBe(first);
  });

  it('preserves user-owned hooks in cursor/hooks.json on upgrade', async () => {
    // Simulate v1.1 user with custom Cursor hooks (hypothetical — hooks are new in v1.2)
    await mkdir(join(tmpDir, '.cursor'), { recursive: true });
    const userOwned = {
      version: 1,
      hooks: {
        sessionEnd: [{ command: 'bash scripts/my-session-end.sh' }],
      },
    };
    await writeFile(join(tmpDir, '.cursor', 'hooks.json'), JSON.stringify(userOwned, null, 2));

    await runInstall({ targetDir: tmpDir, agents: ['cursor'] });

    const merged = JSON.parse(await readFile(join(tmpDir, '.cursor', 'hooks.json'), 'utf8'));
    // User handler preserved; the capture hook is added alongside it.
    expect(merged.hooks.sessionEnd).toHaveLength(2);
    expect(merged.hooks.sessionEnd.some((e: { command: string }) => e.command.includes('session-end-capture.sh'))).toBe(true);
    expect(merged.hooks.sessionEnd.some((e: { command: string }) => e.command.includes('my-session-end.sh'))).toBe(true);
    expect(merged.hooks.preCompact).toHaveLength(1);
  });
});

describe('runInstall — codex hooks', () => {
  it('installs .codex/hooks.json (Claude-style schema) + config.toml + scripts when codex agent selected', async () => {
    const result = await runInstall({ targetDir: tmpDir, agents: ['codex'] });
    expect(result.codexHooksMerged).toBe(true);
    expect(result.codexHooksEventsMerged?.sort()).toEqual(['PostCompact', 'PreCompact', 'SessionEnd', 'SessionStart']);

    expect(existsSync(join(tmpDir, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(tmpDir, '.codex', 'hooks', 'pre-compact.sh'))).toBe(true);
    expect(existsSync(join(tmpDir, '.codex', 'hooks', 'session-end-capture.sh'))).toBe(true);
    // Retired in 1.2.2 — the reminder moved to session start, capture replaced it.
    expect(existsSync(join(tmpDir, '.codex', 'hooks', 'session-log-check.sh'))).toBe(false);
    expect(existsSync(join(tmpDir, '.codex', 'hooks', 'context-reminder.sh'))).toBe(true);

    const config = JSON.parse(await readFile(join(tmpDir, '.codex', 'hooks.json'), 'utf8'));
    expect(Object.keys(config.hooks).sort()).toEqual(['PostCompact', 'PreCompact', 'SessionEnd', 'SessionStart']);
    expect(config.hooks.PreCompact[0].matcher).toBe('manual|auto');
    expect(config.hooks.PreCompact[0].hooks[0].command).toContain('.codex/hooks/pre-compact.sh');
    expect(config.hooks.PostCompact[0].matcher).toBe('manual|auto');
    expect(config.hooks.PostCompact[0].hooks[0].command).toContain('.codex/hooks/context-reminder.sh');

    expect(config.hooks.Stop).toBeUndefined();

    // SessionStart entry: matcher 'startup|resume' + nested type:'command' handler
    const sessionStartEntry = config.hooks.SessionStart[0];
    expect(sessionStartEntry.matcher).toBe('startup|resume');
    expect(sessionStartEntry.hooks[0].type).toBe('command');
    expect(sessionStartEntry.hooks[0].command).toContain('git rev-parse --show-toplevel');
    expect(sessionStartEntry.hooks[0].command).toContain('.codex/hooks/context-reminder.sh');

    // config.toml ensures the Codex hooks feature flag is enabled — without it,
    // Codex CLI will not load hooks.json at all.
    const toml = await readFile(join(tmpDir, '.codex', 'config.toml'), 'utf8');
    expect(toml).toContain('[features]');
    expect(toml).toContain('hooks = true');
    expect(toml).not.toContain('codex_hooks = true');
  });

  it('does not install codex hooks when codex agent not selected', async () => {
    const result = await runInstall({ targetDir: tmpDir, agents: ['claude'] });
    expect(result.codexHooksMerged).toBeUndefined();
    expect(existsSync(join(tmpDir, '.codex'))).toBe(false);
  });

  it('codex hook install is idempotent on reapply', async () => {
    await runInstall({ targetDir: tmpDir, agents: ['codex'] });
    const first = await readFile(join(tmpDir, '.codex', 'hooks.json'), 'utf8');
    const firstToml = await readFile(join(tmpDir, '.codex', 'config.toml'), 'utf8');

    const second = await runInstall({ targetDir: tmpDir, agents: ['codex'] });
    expect(second.codexHooksMerged).toBe(false);

    expect(await readFile(join(tmpDir, '.codex', 'hooks.json'), 'utf8')).toBe(first);
    expect(await readFile(join(tmpDir, '.codex', 'config.toml'), 'utf8')).toBe(firstToml);
  });
});

// A 1.2.1 install has hook scripts under names 1.2.2 no longer ships, and config
// entries pointing at them. `cp -r` copies the template over but never deletes,
// so without installer-stage cleanup those orphans persist forever.
describe('runInstall — upgrading a pre-1.2.2 install', () => {
  const retired = ['session-log-check.sh', 'post-compact-reminder.sh'];

  async function seedOldInstall(dir: string, config: string, contents: object) {
    await mkdir(join(tmpDir, dir, 'hooks'), { recursive: true });
    for (const script of retired) {
      await writeFile(join(tmpDir, dir, 'hooks', script), '#!/bin/bash\nexit 0\n');
    }
    await writeFile(join(tmpDir, dir, config), JSON.stringify(contents, null, 2));
  }

  it('removes retired hook scripts and their registrations, for all three agents', async () => {
    await seedOldInstall('.cursor', 'hooks.json', {
      version: 1,
      hooks: {
        sessionEnd: [{ command: 'bash .cursor/hooks/session-log-check.sh' }],
        sessionStart: [{ command: 'bash .cursor/hooks/post-compact-reminder.sh' }],
        beforeShellExecution: [{ command: 'bash scripts/mine.sh' }],
      },
    });
    await seedOldInstall('.codex', 'hooks.json', {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'bash .codex/hooks/session-log-check.sh' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'bash .codex/hooks/post-compact-reminder.sh' }] }],
      },
    });
    await seedOldInstall('.claude', 'settings.json', {
      hooks: {
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'bash .claude/hooks/session-log-check.sh' }] }],
        SessionStart: [{ matcher: 'compact', hooks: [{ type: 'command', command: 'bash .claude/hooks/post-compact-reminder.sh' }] }],
      },
    });

    await runInstall({ targetDir: tmpDir, agents: ['cursor', 'codex', 'claude'] });

    for (const [dir, config] of [['.cursor', 'hooks.json'], ['.codex', 'hooks.json'], ['.claude', 'settings.json']]) {
      // Orphaned script files are gone from disk...
      for (const script of retired) {
        expect(existsSync(join(tmpDir, dir, 'hooks', script)), `${dir}/${script} should be deleted`).toBe(false);
      }
      // ...their registrations are gone from config...
      const raw = await readFile(join(tmpDir, dir, config), 'utf8');
      for (const script of retired) {
        expect(raw, `${dir}/${config} should not reference ${script}`).not.toContain(script);
      }
      // ...and the replacements are installed.
      expect(existsSync(join(tmpDir, dir, 'hooks', 'context-reminder.sh'))).toBe(true);
      expect(existsSync(join(tmpDir, dir, 'hooks', 'session-end-capture.sh'))).toBe(true);
      expect(raw).toContain('context-reminder.sh');
      expect(raw).toContain('session-end-capture.sh');
    }

    // A user-owned hook in the same file is untouched by any of it.
    const cursor = JSON.parse(await readFile(join(tmpDir, '.cursor', 'hooks.json'), 'utf8'));
    expect(cursor.hooks.beforeShellExecution).toEqual([{ command: 'bash scripts/mine.sh' }]);
  });

  it('leaves a user-authored script of the same name alone outside the hooks dir', async () => {
    await mkdir(join(tmpDir, 'scripts'), { recursive: true });
    const mine = join(tmpDir, 'scripts', 'post-compact-reminder.sh');
    await writeFile(mine, '#!/bin/bash\n# user-authored, not ours\n');
    await runInstall({ targetDir: tmpDir, agents: ['cursor'] });
    expect(existsSync(mine)).toBe(true);
    expect(await readFile(mine, 'utf8')).toContain('user-authored');
  });
});

// Retired-script cleanup deletes files. Two constraints keep that safe, and a
// leftover orphan is inert while a dangling registration is a broken hook —
// so when in doubt, cleanup must NOT delete.
describe('runInstall — retired hook cleanup safety', () => {
  it('does not touch scripts belonging to agents that were not selected', async () => {
    // A project already using Cursor; the user installs only Claude.
    await mkdir(join(tmpDir, '.cursor', 'hooks'), { recursive: true });
    const cursorScript = join(tmpDir, '.cursor', 'hooks', 'post-compact-reminder.sh');
    await writeFile(cursorScript, '#!/bin/bash\nexit 0\n');
    await writeFile(join(tmpDir, '.cursor', 'hooks.json'), JSON.stringify({
      version: 1,
      hooks: { sessionStart: [{ command: 'bash .cursor/hooks/post-compact-reminder.sh' }] },
    }, null, 2));

    await runInstall({ targetDir: tmpDir, agents: ['claude'] });

    // Cursor was never selected, so its registration is untouched — deleting the
    // script would leave that registration pointing at nothing.
    const cursorConfig = await readFile(join(tmpDir, '.cursor', 'hooks.json'), 'utf8');
    expect(cursorConfig).toContain('post-compact-reminder.sh');
    expect(existsSync(cursorScript), 'unselected agent script must survive').toBe(true);
  });

  it('retains retired scripts when config migration is skipped', async () => {
    await mkdir(join(tmpDir, '.cursor', 'hooks'), { recursive: true });
    const script = join(tmpDir, '.cursor', 'hooks', 'post-compact-reminder.sh');
    await writeFile(script, '#!/bin/bash\nexit 0\n');
    // Unparseable config: the merge is skipped, so any existing registration
    // survives and the script it names must survive with it.
    await writeFile(join(tmpDir, '.cursor', 'hooks.json'), '{ not valid json');

    const result = await runInstall({ targetDir: tmpDir, agents: ['cursor'] });

    expect(result.cursorHooksMerged).toBe(false);
    expect(existsSync(script), 'script must survive a skipped migration').toBe(true);
  });

  it('still cleans up when the merge is a no-op because hooks are already present', async () => {
    // "Already present" is success, not failure — cleanup should proceed.
    await runInstall({ targetDir: tmpDir, agents: ['cursor'] });
    const stale = join(tmpDir, '.cursor', 'hooks', 'post-compact-reminder.sh');
    await writeFile(stale, '#!/bin/bash\nexit 0\n');

    const second = await runInstall({ targetDir: tmpDir, agents: ['cursor'] });
    expect(second.cursorHooksMerged).toBe(false);
    expect(existsSync(stale), 'idempotent re-install should still clean orphans').toBe(false);
  });
});
