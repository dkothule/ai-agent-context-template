import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installClaudeHooks, removeHookFromSettings } from '../../src/core/claudeHooks.js';
import { installCursorHooks, removeCursorHooks } from '../../src/core/cursorHooks.js';
import { installCodexHooks, removeCodexHooks } from '../../src/core/codexHooks.js';

let target: string;
beforeEach(async () => { target = await mkdtemp(join(tmpdir(), 'hook-migration-')); });
afterEach(async () => { await rm(target, { recursive: true, force: true }); });
const vendors = [
  { agent: 'claude', file: 'settings.json', start: 'SessionStart', old: 'Stop', install: installClaudeHooks, uninstall: removeHookFromSettings },
  { agent: 'codex', file: 'hooks.json', start: 'SessionStart', old: 'Stop', install: installCodexHooks, uninstall: removeCodexHooks },
  { agent: 'cursor', file: 'hooks.json', start: 'sessionStart', old: 'sessionEnd', install: installCursorHooks, uninstall: removeCursorHooks },
];

describe.each(vendors)('$agent migration', (vendor) => {
  const template = fileURLToPath(new URL(`../../src/templates/${vendor.agent}`, import.meta.url));
  const handler = (script: string) => ({ type: 'command', command: `bash .${vendor.agent}/hooks/${script}` });
  const users = [
    { type: 'command', command: 'bash scripts/first.sh', timeout: 9 },
    { type: 'command', command: 'bash scripts/second.sh', timeout: 11 },
  ];
  const group = (script: string, shared = true) => vendor.agent === 'cursor'
    ? [users[0], handler(script), users[1]]
    : [{ matcher: 'compact', metadata: 'keep this', hooks: shared ? [users[0], handler(script), users[1]] : [handler(script)] }];
  const expectedUsers = vendor.agent === 'cursor' ? users
    : [{ matcher: 'compact', metadata: 'keep this', hooks: users }];
  const configPath = () => join(target, `.${vendor.agent}`, vendor.file);
  const load = async () => JSON.parse(await readFile(configPath(), 'utf8'));
  async function seed(hooks: object) {
    await mkdir(join(target, `.${vendor.agent}`), { recursive: true });
    await writeFile(configPath(), JSON.stringify({ custom: { keep: true }, hooks }));
  }

  it('shared hooks[] entry across install/upgrade/matcher-change preserves user handlers', async () => {
    await seed({
      [vendor.old]: group('session-log-check.sh'),
      [vendor.start]: group('context-reminder.sh'),
      Foreign: vendor.agent === 'cursor' ? users : [{ matcher: 'different', hooks: users }],
    });
    const before = await load();
    await vendor.install(template, target);
    const after = await load();
    expect(after.custom).toEqual(before.custom);
    expect(after.hooks.Foreign).toEqual(before.hooks.Foreign);
    // Cursor's sessionEnd is BOTH the retired reminder event and the capture
    // event, so user handlers are preserved as a prefix and capture is appended.
    // Claude/Codex retire Stop entirely and capture on a separate SessionEnd.
    if (vendor.agent === 'cursor') {
      expect(after.hooks[vendor.old].slice(0, expectedUsers.length)).toEqual(expectedUsers);
      expect(JSON.stringify(after.hooks[vendor.old])).toContain('session-end-capture.sh');
    } else {
      expect(after.hooks[vendor.old]).toEqual(expectedUsers);
    }
    expect(after.hooks[vendor.start].slice(0, expectedUsers.length)).toEqual(expectedUsers);
    const ours = after.hooks[vendor.start].filter((entry: any) => vendor.agent === 'cursor'
      ? entry.command.includes('context-reminder.sh')
      : entry.hooks.some((h: any) => h.command.includes('context-reminder.sh')));
    expect(ours).toHaveLength(1); // exactly-one-SessionStart assertion
    if (vendor.agent === 'claude') {
      for (const event of ['startup', 'resume', 'compact']) {
        expect(new RegExp(`^(?:${ours[0].matcher})$`).test(event)).toBe(true);
      }
    }
    await vendor.uninstall(target);
    expect((await load()).hooks[vendor.start]).toEqual(expectedUsers);
    expect((await load()).hooks[vendor.old]).toEqual(expectedUsers);
  });

  it('preserves user-owned scripts with the same basename outside the managed directory', async () => {
    const ownName = { type: 'command', command: 'bash scripts/session-log-check.sh' };
    const entries = vendor.agent === 'cursor' ? [ownName]
      : [{ matcher: 'user-matcher', hooks: [ownName] }];
    await seed({ [vendor.old]: entries });
    await vendor.install(template, target);
    expect((await load()).hooks[vendor.old].slice(0, entries.length)).toEqual(entries);
    // Only Cursor reuses this event for capture; Claude/Codex leave it user-only.
    if (vendor.agent !== 'cursor') expect((await load()).hooks[vendor.old]).toEqual(entries);
    await vendor.uninstall(target);
    // Uninstall removes the capture hook too, restoring the user's entries.
    expect((await load()).hooks[vendor.old]).toEqual(entries);
  });

  it('legacy sessionEnd/Stop removal and exactly-one-SessionStart assertion', async () => {
    await seed({ [vendor.old]: group('session-log-check.sh', false), [vendor.start]: group('context-reminder.sh', false) });
    await vendor.install(template, target);
    const config = await load();
    if (vendor.agent !== 'cursor') expect(config.hooks[vendor.old]).toBeUndefined();
    else {
      expect(config.hooks[vendor.old].slice(0, users.length)).toEqual(users);
      expect(JSON.stringify(config.hooks[vendor.old])).toContain('session-end-capture.sh');
    }
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain('session-log-check.sh');
    const entries = config.hooks[vendor.start];
    expect(entries.filter((entry: any) => JSON.stringify(entry).includes('context-reminder.sh'))).toHaveLength(1);
  });

  it('migration idempotence and dry-run preservation', async () => {
    await seed({ [vendor.old]: group('session-log-check.sh'), [vendor.start]: group('context-reminder.sh') });
    const before = await readFile(configPath(), 'utf8');
    await vendor.install(template, target, true);
    expect(await readFile(configPath(), 'utf8')).toBe(before);
    await vendor.install(template, target);
    const migrated = await readFile(configPath(), 'utf8');
    await vendor.install(template, target);
    expect(await readFile(configPath(), 'utf8')).toBe(migrated);
  });

  it('legacy uninstall preserves a shared hooks[] entry without prior migration', async () => {
    await seed({ [vendor.old]: group('session-log-check.sh'), [vendor.start]: group('context-reminder.sh') });
    expect(await vendor.uninstall(target)).toBe(true);
    const config = await load();
    expect(config.hooks[vendor.old]).toEqual(expectedUsers);
    expect(config.hooks[vendor.start]).toEqual(expectedUsers);
    expect(config.custom).toEqual({ keep: true });
    expect(await vendor.uninstall(target)).toBe(false);
  });
});
