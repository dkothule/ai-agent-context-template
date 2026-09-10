import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import {
  installCodexHooks,
  removeCodexHooks,
  ensureCodexHooksFeatureFlag,
  removeCodexHooksFeatureFlag,
} from '../../src/core/codexHooks.js';

let tmpDir: string;
let codexDir: string;
let templateCodexDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), 'ai-context-codex-test-' + randomBytes(6).toString('hex'));
  codexDir = join(tmpDir, '.codex');
  templateCodexDir = join(tmpDir, '_template_codex');
  // Simulate copyTemplates having already placed scripts in .codex/hooks/
  await mkdir(join(codexDir, 'hooks'), { recursive: true });
  await writeFile(join(codexDir, 'hooks', 'pre-compact.sh'), '#!/bin/bash\nexit 0\n');
  await writeFile(join(codexDir, 'hooks', 'session-log-check.sh'), '#!/bin/bash\nexit 0\n');
  await writeFile(join(codexDir, 'hooks', 'context-reminder.sh'), '#!/bin/bash\nexit 0\n');
  await mkdir(templateCodexDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

type Handler = { type: string; command: string; timeout?: number };
type Entry = { matcher?: string; hooks: Handler[] };
const findEntry = (arr: Entry[] | undefined, script: string): Entry | undefined =>
  arr?.find((e) => e.hooks?.some((h) => h.command?.includes(script)));

describe('installCodexHooks — fresh install (Claude-style nested schema)', () => {
  it('writes a fresh hooks.json with compaction + session events using the documented schema', async () => {
    const result = await installCodexHooks(templateCodexDir, tmpDir, false);
    expect(result.configMerged).toBe(true);
    expect(result.eventsMerged.sort()).toEqual(['PostCompact', 'PreCompact', 'SessionEnd', 'SessionStart']);
    expect(result.featureFlagEnsured).toBe(true);

    const config = JSON.parse(await readFile(join(codexDir, 'hooks.json'), 'utf8'));
    // Codex doesn't use a top-level `version` field (Claude-style schema).
    expect(config.version).toBeUndefined();

    const preCompactEntry = findEntry(config.hooks.PreCompact, 'pre-compact.sh');
    expect(preCompactEntry).toBeDefined();
    expect(preCompactEntry!.matcher).toBe('manual|auto');
    expect(preCompactEntry!.hooks[0].type).toBe('command');
    expect(preCompactEntry!.hooks[0].command).toContain('git rev-parse --show-toplevel');

    const postCompactEntry = findEntry(config.hooks.PostCompact, 'context-reminder.sh');
    expect(postCompactEntry).toBeDefined();
    expect(postCompactEntry!.matcher).toBe('manual|auto');
    expect(postCompactEntry!.hooks[0].type).toBe('command');
    expect(postCompactEntry!.hooks[0].command).toContain('git rev-parse --show-toplevel');

    expect(config.hooks.Stop).toBeUndefined();

    // SessionStart event: matcher 'startup|resume', hooks[] with type:'command'
    const sessionStartEntry = findEntry(config.hooks.SessionStart, 'context-reminder.sh');
    expect(sessionStartEntry).toBeDefined();
    expect(sessionStartEntry!.matcher).toBe('startup|resume');
    expect(sessionStartEntry!.hooks[0].type).toBe('command');
    expect(sessionStartEntry!.hooks[0].command).toContain('git rev-parse --show-toplevel');
  });

  it('writes a fresh config.toml enabling the Codex hooks feature flag', async () => {
    await installCodexHooks(templateCodexDir, tmpDir, false);
    const toml = await readFile(join(codexDir, 'config.toml'), 'utf8');
    expect(toml).toContain('[features]');
    expect(toml).toContain('hooks = true');
    expect(toml).not.toContain('codex_hooks = true');
  });
});

describe('installCodexHooks — upgrade / idempotency', () => {
  it('is idempotent: a second run leaves hooks.json unchanged', async () => {
    await installCodexHooks(templateCodexDir, tmpDir, false);
    const first = await readFile(join(codexDir, 'hooks.json'), 'utf8');

    const second = await installCodexHooks(templateCodexDir, tmpDir, false);
    expect(second.configMerged).toBe(false);
    expect(second.configSkipReason).toBe('AI Context hooks already present');

    const after = await readFile(join(codexDir, 'hooks.json'), 'utf8');
    expect(after).toBe(first);
  });

  it('preserves user-owned hooks in the same events and adds ours additively', async () => {
    const userOwned = {
      hooks: {
        Stop: [
          {
            hooks: [{ type: 'command', command: 'bash scripts/my-stop.sh', timeout: 60 }],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [{ type: 'command', command: 'bash scripts/audit-prompt.sh' }],
          },
        ],
      },
    };
    await writeFile(join(codexDir, 'hooks.json'), JSON.stringify(userOwned, null, 2));

    const result = await installCodexHooks(templateCodexDir, tmpDir, false);
    expect(result.configMerged).toBe(true);

    const merged = JSON.parse(await readFile(join(codexDir, 'hooks.json'), 'utf8'));
    // User-owned event preserved verbatim
    expect(merged.hooks.UserPromptSubmit).toEqual(userOwned.hooks.UserPromptSubmit);
    // Stop retains only user hooks
    expect(merged.hooks.Stop).toHaveLength(1);
    expect(findEntry(merged.hooks.Stop, 'my-stop.sh')).toBeDefined();
    expect(findEntry(merged.hooks.Stop, 'session-log-check.sh')).toBeUndefined();
    expect(findEntry(merged.hooks.PreCompact, 'pre-compact.sh')).toBeDefined();
    expect(findEntry(merged.hooks.PostCompact, 'context-reminder.sh')).toBeDefined();
    expect(findEntry(merged.hooks.SessionStart, 'context-reminder.sh')).toBeDefined();
  });

  it('dry-run does not write anything', async () => {
    const existing = { hooks: {} };
    await writeFile(join(codexDir, 'hooks.json'), JSON.stringify(existing));

    const result = await installCodexHooks(templateCodexDir, tmpDir, true);
    expect(result.configMerged).toBe(true);

    const raw = await readFile(join(codexDir, 'hooks.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual(existing);
    expect(existsSync(join(codexDir, 'config.toml'))).toBe(false);
  });

  it('skips on invalid JSON without throwing', async () => {
    await writeFile(join(codexDir, 'hooks.json'), '{ not valid json');
    const result = await installCodexHooks(templateCodexDir, tmpDir, false);
    expect(result.configMerged).toBe(false);
    expect(result.configSkipReason).toBe('hooks.json is not valid JSON');
  });
});

describe('ensureCodexHooksFeatureFlag', () => {
  it('writes a fresh config.toml when none exists', async () => {
    const path = join(codexDir, 'config.toml');
    const changed = await ensureCodexHooksFeatureFlag(path, false);
    expect(changed).toBe(true);

    const toml = await readFile(path, 'utf8');
    expect(toml).toContain('[features]');
    expect(toml).toContain('hooks = true');
  });

  it('no-ops when hooks = true is already present', async () => {
    const path = join(codexDir, 'config.toml');
    await writeFile(path, '[features]\nhooks = true\nfoo = true\n');

    const changed = await ensureCodexHooksFeatureFlag(path, false);
    expect(changed).toBe(false);

    const toml = await readFile(path, 'utf8');
    expect(toml).toBe('[features]\nhooks = true\nfoo = true\n');
  });

  it('migrates legacy codex_hooks = true to hooks = true', async () => {
    const path = join(codexDir, 'config.toml');
    await writeFile(path, '[features]\ncodex_hooks = true\nfoo = true\n');

    const changed = await ensureCodexHooksFeatureFlag(path, false);
    expect(changed).toBe(true);

    const toml = await readFile(path, 'utf8');
    expect(toml).toBe('[features]\nhooks = true\nfoo = true\n');
  });

  it('inserts the flag right after an existing [features] header that lacks it', async () => {
    const path = join(codexDir, 'config.toml');
    await writeFile(path, '[features]\nother_flag = true\n');

    const changed = await ensureCodexHooksFeatureFlag(path, false);
    expect(changed).toBe(true);

    const toml = await readFile(path, 'utf8');
    expect(toml).toContain('[features]\nhooks = true\nother_flag = true');
  });

  it('appends a [features] block when one is not present', async () => {
    const path = join(codexDir, 'config.toml');
    await writeFile(path, '[ui]\ntheme = "dark"\n');

    const changed = await ensureCodexHooksFeatureFlag(path, false);
    expect(changed).toBe(true);

    const toml = await readFile(path, 'utf8');
    expect(toml).toContain('[ui]\ntheme = "dark"');
    expect(toml).toContain('[features]\nhooks = true');
    // Order matters: existing [ui] block comes before the appended [features] block.
    expect(toml.indexOf('[ui]')).toBeLessThan(toml.indexOf('[features]'));
  });

  it('dry-run does not write the file', async () => {
    const path = join(codexDir, 'config.toml');
    const changed = await ensureCodexHooksFeatureFlag(path, true);
    expect(changed).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  // Regression: commented-out documentation lines must not be treated as enabled.
  // Earlier versions did `raw.includes("hooks = true")` which would
  // false-positive on `# hooks = true` in a doc comment.
  it('treats a commented-out flag as not present and adds an active one', async () => {
    const path = join(codexDir, 'config.toml');
    await writeFile(
      path,
      '# Example: enable hooks by uncommenting the next line\n# hooks = true\n',
    );

    const changed = await ensureCodexHooksFeatureFlag(path, false);
    expect(changed).toBe(true);

    const toml = await readFile(path, 'utf8');
    // The original doc comment is preserved
    expect(toml).toContain('# hooks = true');
    // And a new ACTIVE [features] block was appended
    expect(toml).toMatch(/\[features\][\s\S]*\bhooks = true\b/);
    // The active line is not preceded by `#` on its own line
    const lines = toml.split('\n').map((l) => l.trim());
    const activeIdx = lines.findIndex((l) => l === 'hooks = true');
    expect(activeIdx).toBeGreaterThan(-1);
  });

  // Regression: if an existing `hooks = false` is present, replace its
  // value rather than inserting a duplicate key (which would be invalid TOML).
  it('replaces hooks = false in place rather than inserting a duplicate key', async () => {
    const path = join(codexDir, 'config.toml');
    await writeFile(path, '[features]\nhooks = false\nother_flag = true\n');

    const changed = await ensureCodexHooksFeatureFlag(path, false);
    expect(changed).toBe(true);

    const toml = await readFile(path, 'utf8');
    expect(toml).toContain('hooks = true');
    expect(toml).not.toContain('hooks = false');
    // Only one `hooks` assignment in the file
    const occurrences = (toml.match(/^\s*hooks\s*=/gm) || []).length;
    expect(occurrences).toBe(1);
    // Sibling key preserved
    expect(toml).toContain('other_flag = true');
  });

  it('migrates legacy codex_hooks = false to hooks = true', async () => {
    const path = join(codexDir, 'config.toml');
    await writeFile(path, '[features]\ncodex_hooks = false\nother_flag = true\n');

    const changed = await ensureCodexHooksFeatureFlag(path, false);
    expect(changed).toBe(true);

    const toml = await readFile(path, 'utf8');
    expect(toml).toContain('hooks = true');
    expect(toml).not.toContain('codex_hooks = false');
    expect(toml).not.toContain('codex_hooks = true');
    expect(toml).toContain('other_flag = true');
  });

  it('handles trailing inline comment on the existing assignment', async () => {
    const path = join(codexDir, 'config.toml');
    await writeFile(path, '[features]\nhooks = false  # disabled for now\n');

    const changed = await ensureCodexHooksFeatureFlag(path, false);
    expect(changed).toBe(true);

    const toml = await readFile(path, 'utf8');
    // The line was replaced — the comment goes away with it (acceptable; we
    // own the line value when we change it). Active line is `hooks = true`.
    expect(toml).toContain('hooks = true');
    expect(toml).not.toContain('hooks = false');
    const occurrences = (toml.match(/^\s*hooks\s*=/gm) || []).length;
    expect(occurrences).toBe(1);
  });

  // Regression: prior version did `raw.includes("hooks")` and would
  // mistake a same-named key under another table for the feature flag.
  // Must be table-aware.
  it('does NOT treat `hooks` under another table as the feature flag', async () => {
    const path = join(codexDir, 'config.toml');
    await writeFile(
      path,
      // `hooks = true` here belongs to [some_other_tool], NOT [features]
      '[some_other_tool]\nhooks = true\n\n[features]\nother_flag = true\n',
    );

    const changed = await ensureCodexHooksFeatureFlag(path, false);
    expect(changed).toBe(true);

    const toml = await readFile(path, 'utf8');
    // The other table's key is preserved as-is.
    expect(toml).toMatch(/\[some_other_tool\][\s\S]*?hooks = true/);
    // And our key is now properly added under [features].
    expect(toml).toMatch(/\[features\][\s\S]*?hooks = true/);
    // Two distinct hooks lines, but each scoped to its own table.
    const occurrences = (toml.match(/^\s*hooks\s*=/gm) || []).length;
    expect(occurrences).toBe(2);
  });

  it('does NOT mistake `hooks = false` in another table as enabled', async () => {
    const path = join(codexDir, 'config.toml');
    // `hooks = false` belongs to [some_other_tool], not [features].
    // We must add `[features].hooks = true` and leave the other untouched.
    await writeFile(path, '[some_other_tool]\nhooks = false\n');

    const changed = await ensureCodexHooksFeatureFlag(path, false);
    expect(changed).toBe(true);

    const toml = await readFile(path, 'utf8');
    expect(toml).toMatch(/\[some_other_tool\][\s\S]*?hooks = false/);
    expect(toml).toMatch(/\[features\][\s\S]*?hooks = true/);
  });

  it('recognises top-level dotted form `features.hooks = true` as already enabled', async () => {
    const path = join(codexDir, 'config.toml');
    await writeFile(path, 'features.hooks = true\n');

    const changed = await ensureCodexHooksFeatureFlag(path, false);
    expect(changed).toBe(false);

    const toml = await readFile(path, 'utf8');
    // Untouched.
    expect(toml).toBe('features.hooks = true\n');
  });

  it('replaces dotted form `features.hooks = false` in place', async () => {
    const path = join(codexDir, 'config.toml');
    await writeFile(path, 'features.hooks = false\nother_top_level = "x"\n');

    const changed = await ensureCodexHooksFeatureFlag(path, false);
    expect(changed).toBe(true);

    const toml = await readFile(path, 'utf8');
    expect(toml).toContain('features.hooks = true');
    expect(toml).not.toContain('features.hooks = false');
    // Other content preserved.
    expect(toml).toContain('other_top_level = "x"');
    // Single source of truth — no new [features] block was appended.
    expect(toml).not.toContain('[features]');
  });

  it('tolerates a trailing inline comment on the [features] header', async () => {
    const path = join(codexDir, 'config.toml');
    await writeFile(path, '[features]  # codex experimental flags\nother = true\n');

    const changed = await ensureCodexHooksFeatureFlag(path, false);
    expect(changed).toBe(true);

    const toml = await readFile(path, 'utf8');
    // The flag was inserted into the existing [features] block — no new
    // [features] header appended.
    const headerCount = (toml.match(/^\s*\[features\]/gm) || []).length;
    expect(headerCount).toBe(1);
    expect(toml).toContain('hooks = true');
    expect(toml).toContain('other = true');
  });
});

describe('removeCodexHooksFeatureFlag (scaffold-only deletion)', () => {
  it('returns false if config.toml does not exist', async () => {
    expect(await removeCodexHooksFeatureFlag(tmpDir, false)).toBe(false);
  });

  it('deletes the file when content is exactly the AI Context scaffold (created by us)', async () => {
    // Simulate a fresh install: ensureCodexHooksFeatureFlag writes the scaffold.
    await ensureCodexHooksFeatureFlag(join(codexDir, 'config.toml'), false);

    const changed = await removeCodexHooksFeatureFlag(tmpDir, false);
    expect(changed).toBe(true);
    expect(existsSync(join(codexDir, 'config.toml'))).toBe(false);
  });

  // Regression: the previous implementation would remove an active
  // [features].hooks = true line regardless of who authored the file.
  // That silently disabled user-owned Codex hooks. Now we only delete the
  // file if it is byte-for-byte our scaffold.
  it('does NOT touch a user-authored config.toml that happens to contain [features] hooks = true', async () => {
    const path = join(codexDir, 'config.toml');
    const userContent = '# user file\n[features]\nhooks = true\nuser_flag = true\n';
    await writeFile(path, userContent);

    const changed = await removeCodexHooksFeatureFlag(tmpDir, false);
    expect(changed).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(userContent);
  });

  it('does NOT touch a user file that has been customised on top of our scaffold', async () => {
    // User installed AI Context, then later added their own line. Our scaffold
    // marker is gone, so we conservatively leave the file alone.
    const path = join(codexDir, 'config.toml');
    await ensureCodexHooksFeatureFlag(path, false);
    const customised = (await readFile(path, 'utf8')) + '\nuser_flag = true\n';
    await writeFile(path, customised);

    const changed = await removeCodexHooksFeatureFlag(tmpDir, false);
    expect(changed).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(customised);
  });

  it('does NOT touch a config.toml where AI Context appended a [features] block to existing content', async () => {
    // ensureCodexHooksFeatureFlag's "append" branch produces non-scaffold content.
    const path = join(codexDir, 'config.toml');
    await writeFile(path, '[ui]\ntheme = "dark"\n');
    await ensureCodexHooksFeatureFlag(path, false);
    const after = await readFile(path, 'utf8');

    const changed = await removeCodexHooksFeatureFlag(tmpDir, false);
    expect(changed).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(after);
  });

  it('does NOT touch `hooks = false` even when our scaffold marker is present (defense-in-depth)', async () => {
    // Hypothetical: someone manually edited our scaffold's `true` to `false`.
    const path = join(codexDir, 'config.toml');
    await ensureCodexHooksFeatureFlag(path, false);
    const edited = (await readFile(path, 'utf8')).replace('hooks = true', 'hooks = false');
    await writeFile(path, edited);

    const changed = await removeCodexHooksFeatureFlag(tmpDir, false);
    expect(changed).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(edited);
  });

  it('does NOT touch a config.toml created entirely by the user before AI Context was installed', async () => {
    // Codex was never selected; user has their own config. We must not
    // touch this file under any circumstance during uninstall.
    const path = join(codexDir, 'config.toml');
    const userContent = '# my codex config\n[features]\nhooks = true\n[ui]\ntheme = "dark"\n';
    await writeFile(path, userContent);

    const changed = await removeCodexHooksFeatureFlag(tmpDir, false);
    expect(changed).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(userContent);
  });
});

describe('removeCodexHooks', () => {
  it('removes both AI Context entries and deletes the stub file (only had our content)', async () => {
    await installCodexHooks(templateCodexDir, tmpDir, false);

    const removed = await removeCodexHooks(tmpDir, false);
    expect(removed).toBe(true);

    // Codex hooks.json is purely our scaffold on fresh install, so an
    // uninstall should remove it entirely (no `{}` residue).
    expect(existsSync(join(codexDir, 'hooks.json'))).toBe(false);
  });

  it('preserves the file when user has non-stub top-level keys', async () => {
    await installCodexHooks(templateCodexDir, tmpDir, false);
    const config = JSON.parse(await readFile(join(codexDir, 'hooks.json'), 'utf8'));
    (config as Record<string, unknown>).other_setting = 'something';
    await writeFile(join(codexDir, 'hooks.json'), JSON.stringify(config, null, 2));

    const removed = await removeCodexHooks(tmpDir, false);
    expect(removed).toBe(true);

    expect(existsSync(join(codexDir, 'hooks.json'))).toBe(true);
    const after = JSON.parse(await readFile(join(codexDir, 'hooks.json'), 'utf8'));
    expect(after.hooks).toBeUndefined();
    expect(after.other_setting).toBe('something');
  });

  it('leaves user-owned entries intact', async () => {
    const settings = {
      hooks: {
        Stop: [
          {
            hooks: [{ type: 'command', command: 'bash scripts/my-stop.sh' }],
          },
          {
            hooks: [{ type: 'command', command: 'bash .codex/hooks/session-log-check.sh', timeout: 30 }],
          },
        ],
        SessionStart: [
          {
            matcher: 'startup|resume',
            hooks: [{ type: 'command', command: 'bash .codex/hooks/context-reminder.sh' }],
          },
        ],
      },
    };
    await writeFile(join(codexDir, 'hooks.json'), JSON.stringify(settings, null, 2));

    const removed = await removeCodexHooks(tmpDir, false);
    expect(removed).toBe(true);

    const updated = JSON.parse(await readFile(join(codexDir, 'hooks.json'), 'utf8'));
    expect(updated.hooks.Stop).toHaveLength(1);
    expect(findEntry(updated.hooks.Stop, 'my-stop.sh')).toBeDefined();
    expect(updated.hooks.SessionStart).toBeUndefined();
  });

  it('returns false when no AI Context hooks are present', async () => {
    await writeFile(join(codexDir, 'hooks.json'), JSON.stringify({ hooks: {} }));
    expect(await removeCodexHooks(tmpDir, false)).toBe(false);
  });

  it('returns false if hooks.json does not exist', async () => {
    expect(existsSync(join(codexDir, 'hooks.json'))).toBe(false);
    expect(await removeCodexHooks(tmpDir, false)).toBe(false);
  });
});
