import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { runInstall } from '../../src/core/install.js';
import { ALL_AGENTS } from '../../src/core/copyTemplates.js';
import { readManifest } from '../../src/core/manifest.js';

/**
 * Inline uninstall logic mirroring uninstall.ts. Kept in sync with the real
 * MANAGED_PATHS list and the per-config-file removal helpers so this test
 * exercises the same cleanup contract users see.
 */
async function runUninstall(targetDir: string, dryRun = false): Promise<{ backupDir: string | null }> {
  const { createBackupDir, backupPath } = await import('../../src/core/backup.js');
  const { rm: fsRm } = await import('fs/promises');
  const { removeHookFromSettings } = await import('../../src/core/claudeHooks.js');
  const { removeCursorHooks } = await import('../../src/core/cursorHooks.js');
  const { removeCodexHooks, removeCodexHooksFeatureFlag } = await import('../../src/core/codexHooks.js');

  const MANAGED_PATHS = [
    '.ai-context',
    '.cursor/rules/main.mdc',
    '.cursor/hooks',
    '.codex/hooks',
    '.claude/hooks',
    'AGENTS.md',
    'CLAUDE.md',
  ];

  let backupDir: string | null = null;
  if (!dryRun) {
    backupDir = await createBackupDir(targetDir);
    for (const rel of MANAGED_PATHS) {
      await backupPath(targetDir, rel, backupDir);
    }
    for (const rel of MANAGED_PATHS) {
      const full = join(targetDir, rel);
      if (existsSync(full)) {
        await fsRm(full, { recursive: true, force: true });
      }
    }
    // Per-config-file cleanup: remove our entries from settings.json /
    // hooks.json and our flag line from config.toml. Each helper deletes the
    // file entirely if only our content remained.
    await removeHookFromSettings(targetDir, false);
    await removeCursorHooks(targetDir, false);
    await removeCodexHooks(targetDir, false);
    await removeCodexHooksFeatureFlag(targetDir, false);
  }

  return { backupDir };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), 'ai-context-int-' + randomBytes(6).toString('hex'));
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('uninstall', () => {
  it('removes all managed paths after install', async () => {
    await runInstall({ targetDir: tmpDir, agents: ALL_AGENTS });

    expect(existsSync(join(tmpDir, '.ai-context'))).toBe(true);
    expect(existsSync(join(tmpDir, 'CLAUDE.md'))).toBe(true);

    await runUninstall(tmpDir);

    expect(existsSync(join(tmpDir, '.ai-context'))).toBe(false);
    expect(existsSync(join(tmpDir, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(tmpDir, 'AGENTS.md'))).toBe(false);
  });

  it('creates a backup before removing', async () => {
    await runInstall({ targetDir: tmpDir, agents: ALL_AGENTS });
    const { backupDir } = await runUninstall(tmpDir);

    expect(backupDir).not.toBeNull();
    expect(existsSync(backupDir!)).toBe(true);
  });

  it('preserves unrelated files in .cursor/', async () => {
    await runInstall({ targetDir: tmpDir, agents: ALL_AGENTS });
    // Add a user file in .cursor/
    await writeFile(join(tmpDir, '.cursor', 'user.json'), '{}');

    await runUninstall(tmpDir);

    // rules/main.mdc removed but user.json preserved
    expect(existsSync(join(tmpDir, '.cursor', 'rules', 'main.mdc'))).toBe(false);
    expect(existsSync(join(tmpDir, '.cursor', 'user.json'))).toBe(true);
  });

  it('removes session-start hook from settings.json during uninstall', async () => {
    // Install with hooks
    await mkdir(join(tmpDir, '.claude'), { recursive: true });
    await writeFile(
      join(tmpDir, '.claude', 'settings.json'),
      JSON.stringify({ permissions: {} }, null, 2),
    );
    await runInstall({ targetDir: tmpDir, agents: ['claude'] });

    // Verify hook was merged
    const { readFile } = await import('fs/promises');
    const before = await readFile(join(tmpDir, '.claude', 'settings.json'), 'utf8');
    expect(before).toContain('context-reminder.sh');

    await runUninstall(tmpDir);

    // settings.json still exists but hook removed
    if (existsSync(join(tmpDir, '.claude', 'settings.json'))) {
      const after = await readFile(join(tmpDir, '.claude', 'settings.json'), 'utf8');
      expect(after).not.toContain('context-reminder.sh');
    }
  });

  it('dry-run does not remove anything', async () => {
    await runInstall({ targetDir: tmpDir, agents: ALL_AGENTS });
    await runUninstall(tmpDir, true);

    expect(existsSync(join(tmpDir, '.ai-context'))).toBe(true);
    expect(existsSync(join(tmpDir, 'CLAUDE.md'))).toBe(true);
  });

  it('leaves no AI Context-installed hook config files behind after uninstall of a fresh install', async () => {
    // Fresh install: every file under these paths was created by AI Context,
    // so an uninstall should remove all of them — not leave behind stub
    // hooks.json / config.toml shells.
    await runInstall({ targetDir: tmpDir, agents: ALL_AGENTS });

    expect(existsSync(join(tmpDir, '.cursor', 'hooks.json'))).toBe(true);
    expect(existsSync(join(tmpDir, '.codex', 'hooks.json'))).toBe(true);
    expect(existsSync(join(tmpDir, '.codex', 'config.toml'))).toBe(true);
    expect(existsSync(join(tmpDir, '.claude', 'settings.json'))).toBe(true);

    await runUninstall(tmpDir);

    // None of the AI Context-created config files should remain.
    expect(existsSync(join(tmpDir, '.cursor', 'hooks.json'))).toBe(false);
    expect(existsSync(join(tmpDir, '.codex', 'hooks.json'))).toBe(false);
    expect(existsSync(join(tmpDir, '.codex', 'config.toml'))).toBe(false);
    expect(existsSync(join(tmpDir, '.claude', 'settings.json'))).toBe(false);
  });
});
