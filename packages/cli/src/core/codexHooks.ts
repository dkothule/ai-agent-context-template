import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

/**
 * Script names AI Context installs into .codex/hooks/. Used to detect our
 * hook entries in hooks.json (avoid duplicates on upgrade; clean up on uninstall).
 *
 * Scripts themselves are copied by `copyTemplates` (since AGENT_FILES.codex
 * includes the `codex/` directory). This module manages the JSON + TOML config
 * — keeping `hooks.json` and `config.toml` out of the template tree ensures
 * `copyTemplates` never overwrites a user's customised configuration.
 *
 * Codex exposes compaction lifecycle hooks, so we wire PreCompact autosave and
 * PostCompact reminder in addition to the forward-looking SessionStart reminder.
 *
 * Schema reference: https://developers.openai.com/codex/hooks
 *   - Same nested format as Claude Code: `event[].matcher? + event[].hooks[]`
 *     where each entry has `{ type: 'command', command, timeout? }`.
 *   - Requires `[features] hooks = true` in `.codex/config.toml`.
 */
const HOOK_SCRIPTS = {
  preCompact: 'pre-compact.sh',
  stop: 'session-log-check.sh', // Legacy: remove on upgrade/uninstall.
  postCompact: 'context-reminder.sh',
  sessionStart: 'context-reminder.sh',
  postCompactLegacy: 'post-compact-reminder.sh', // Legacy name: remove on upgrade/uninstall.
  sessionEnd: 'session-end-capture.sh',
} as const;

const ALL_HOOK_SCRIPTS: string[] = [...new Set(Object.values(HOOK_SCRIPTS))];

const HOOK_TIMEOUT_SECONDS = 30;

/**
 * Codex caps SessionEnd hooks at 1s default / 3s maximum and cancels unfinished
 * hooks when the session ends. The capture script is budgeted for well under
 * this (~120ms measured); do not raise it — Codex will reject or truncate.
 */
const SESSION_END_TIMEOUT_SECONDS = 3;

interface CodexHookHandler {
  type: string;
  command: string;
  timeout?: number;
  statusMessage?: string;
}

interface CodexHookEntry {
  matcher?: string;
  hooks: CodexHookHandler[];
}

interface CodexHooksFile {
  hooks?: Record<string, CodexHookEntry[]>;
  [key: string]: unknown;
}

/**
 * Build the shell command for a Codex hook script.
 *
 * Codex docs explicitly recommend resolving repo-local hooks from the git root
 * because Codex may start in a subdirectory:
 *   "For repo-local hooks, prefer resolving from the git root instead of using
 *    a relative path such as `.codex/hooks/...`. Codex may be started from a
 *    subdirectory, and a git-root-based path keeps the hook location stable."
 *
 * The fallback to `pwd` keeps the command working in non-git checkouts.
 */
function buildHookCommand(scriptName: string): string {
  return `bash "$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.codex/hooks/${scriptName}"`;
}

/**
 * Session-end launcher. The normal launcher embeds `$(git rev-parse …)`, which
 * the agent's shell evaluates BEFORE bash starts the script — so a slow git
 * there defeats every in-script protection and the capture never runs at all.
 * Session-end budgets are the tightest we have (Codex 1s/3s, Claude a shared
 * 1.5s), so locate the script by walking parent directories with shell builtins.
 * This handles a nested CWD without invoking Git before capture begins.
 */
function buildSessionEndCommand(scriptName: string): string {
  const rel = `.codex/hooks/${scriptName}`;
  // Walk up from CWD using shell builtins only. `git rev-parse` here would be
  // unbounded and runs BEFORE bash starts the script, so a slow git would mean
  // no capture at all — and CWD is not guaranteed to be the repository root.
  // Exits 0 when nothing is found: a session must never fail to end here.
  const walk = `d="$PWD"; while [ -n "$d" ] && [ ! -f "$d/${rel}" ]; do d="\${d%/*}"; done; [ -n "$d" ] && exec bash "$d/${rel}"; exit 0`;
  return `bash -c '${walk}'`;
}

/**
 * Builds the hooks block AI Context installs into .codex/hooks.json.
 * SessionStart matches `startup|resume`,
 * which mirrors the schema example in the Codex docs.
 */
function buildHooksBlock(): Record<string, CodexHookEntry[]> {
  return {
    PreCompact: [
      {
        matcher: 'manual|auto',
        hooks: [
          {
            type: 'command',
            command: buildHookCommand(HOOK_SCRIPTS.preCompact),
            timeout: HOOK_TIMEOUT_SECONDS,
          },
        ],
      },
    ],
    PostCompact: [
      {
        matcher: 'manual|auto',
        hooks: [
          {
            type: 'command',
            command: buildHookCommand(HOOK_SCRIPTS.postCompact),
            timeout: HOOK_TIMEOUT_SECONDS,
          },
        ],
      },
    ],
    // Fires once per session at the boundary. Cannot inject context, so it
    // captures to disk. Hard 3s ceiling — see SESSION_END_TIMEOUT_SECONDS.
    SessionEnd: [
      {
        hooks: [
          {
            type: 'command',
            command: buildSessionEndCommand(HOOK_SCRIPTS.sessionEnd),
            timeout: SESSION_END_TIMEOUT_SECONDS,
          },
        ],
      },
    ],
    SessionStart: [
      {
        matcher: 'startup|resume',
        hooks: [
          {
            type: 'command',
            command: buildHookCommand(HOOK_SCRIPTS.sessionStart),
            timeout: HOOK_TIMEOUT_SECONDS,
          },
        ],
      },
    ],
  };
}

export interface CodexHooksInstallResult {
  /** True if scripts are present in `.codex/hooks/` (copied by copyTemplates). */
  hooksCopied: boolean;
  configMerged: boolean;
  configSkipReason?: string;
  /** Which hook events had our entries added (or would be added, in dry-run). */
  eventsMerged: string[];
  /** True if `.codex/config.toml` was written or updated to enable Codex hooks. */
  featureFlagEnsured: boolean;
}

/**
 * Installs Codex hooks into the target project.
 *
 * Two artifacts are managed:
 *   - `.codex/hooks.json` — event definitions, additively merged
 *   - `.codex/config.toml` — required `[features] hooks = true` flag,
 *     written if missing or appended if `[features]` exists without the flag
 */
export async function installCodexHooks(
  templateCodexDir: string,
  targetDir: string,
  dryRun = false,
): Promise<CodexHooksInstallResult> {
  const targetCodexDir = join(targetDir, '.codex');
  const targetHooksDir = join(targetCodexDir, 'hooks');
  const targetHooksJson = join(targetCodexDir, 'hooks.json');
  const targetConfigToml = join(targetCodexDir, 'config.toml');

  void templateCodexDir;
  const hooksCopied = existsSync(join(targetHooksDir, HOOK_SCRIPTS.preCompact));

  if (!dryRun) {
    await mkdir(targetCodexDir, { recursive: true });
  }

  const mergeResult = await mergeHooksIntoConfig(targetHooksJson, dryRun);
  const featureFlagEnsured = await ensureCodexHooksFeatureFlag(targetConfigToml, dryRun);

  return {
    hooksCopied,
    configMerged: mergeResult.merged,
    configSkipReason: mergeResult.skipReason,
    eventsMerged: mergeResult.eventsMerged,
    featureFlagEnsured,
  };
}

interface MergeResult {
  merged: boolean;
  skipReason?: string;
  eventsMerged: string[];
}

function ourScriptInCommand(cmd?: string): string | null {
  if (!cmd) return null;
  // A same-named script outside our managed directory belongs to the user.
  const normalized = cmd.replace(/\\/g, '/');
  return ALL_HOOK_SCRIPTS.find((name) => {
    const managedPath = '.codex/hooks/' + name;
    const index = normalized.indexOf(managedPath);
    if (index < 0) return false;
    const before = normalized[index - 1];
    const after = normalized[index + managedPath.length];
    return (!before || /[\s/"']/.test(before)) && (!after || /[\s"';]/.test(after));
  }) ?? null;
}

// Remove only our handlers. User siblings retain their matcher, metadata and order.
// Matching ignores the old matcher so SessionStart can migrate without duplicates.
function withoutOurHooks(entries: CodexHookEntry[]): CodexHookEntry[] {
  return entries.flatMap((entry) => {
    if (!Array.isArray(entry.hooks)) return [entry];
    const hooks = entry.hooks.filter((handler) => ourScriptInCommand(handler.command) === null);
    if (hooks.length === entry.hooks.length) return [entry];
    return hooks.length ? [{ ...entry, hooks }] : [];
  });
}

async function mergeHooksIntoConfig(
  hooksPath: string,
  dryRun: boolean,
): Promise<MergeResult> {
  const ours = buildHooksBlock();

  if (!existsSync(hooksPath)) {
    if (!dryRun) {
      await mkdir(dirname(hooksPath), { recursive: true });
      await writeFile(
        hooksPath,
        JSON.stringify({ hooks: ours }, null, 2) + '\n',
        'utf8',
      );
    }
    return { merged: true, eventsMerged: Object.keys(ours) };
  }

  const raw = await readFile(hooksPath, 'utf8');

  let config: CodexHooksFile;
  try {
    config = JSON.parse(raw);
  } catch {
    return { merged: false, skipReason: 'hooks.json is not valid JSON', eventsMerged: [] };
  }

  const existingHooks = config.hooks ?? {};
  const mergedHooks: Record<string, CodexHookEntry[]> = { ...existingHooks };

  const eventsMerged: string[] = [];

  // Normalize our registrations across all events (including retired ones),
  // preserving user handlers before adding the current canonical registrations.
  for (const event of new Set([...Object.keys(existingHooks), ...Object.keys(ours)])) {
    const previous = existingHooks[event];
    const userEntries = Array.isArray(previous) ? withoutOurHooks(previous) : [];
    const next = [...userEntries, ...(ours[event] ?? [])];
    // Preserve unrelated events, including empty arrays, exactly as supplied.
    if (!ours[event] && JSON.stringify(previous) === JSON.stringify(userEntries)) continue;
    if (JSON.stringify(previous) === JSON.stringify(next)) continue;
    if (next.length) mergedHooks[event] = next;
    else delete mergedHooks[event];
    eventsMerged.push(event);
  }

  if (eventsMerged.length === 0) {
    return { merged: false, skipReason: 'AI Context hooks already present', eventsMerged: [] };
  }

  const merged: CodexHooksFile = { ...config, hooks: mergedHooks };

  if (!dryRun) {
    await writeFile(hooksPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  }

  return { merged: true, eventsMerged };
}

const FEATURE_FLAG_KEY = 'hooks';
const LEGACY_FEATURE_FLAG_KEY = 'codex_hooks';
const FEATURE_FLAG_LINE = `${FEATURE_FLAG_KEY} = true`;
const FEATURES_HEADER = '[features]';
// Plain hook feature assignment (key + value-capturing). Only meaningful when
// the line is inside the `[features]` table. The legacy `codex_hooks` key is
// recognised so upgrades rewrite it to the current `hooks` key.
const PLAIN_FLAG_RE = /^(hooks|codex_hooks)\s*=\s*(.+)$/;
// Dotted form `features.hooks = X`. Top-level dotted keys are table-independent
// and equivalent to placing the key under `[features]`.
const DOTTED_FLAG_RE = /^features\.(hooks|codex_hooks)\s*=\s*(.+)$/;
// Table header line. `[features]` (with optional surrounding whitespace and
// optional trailing inline comment). Other tables are matched generically.
const TABLE_HEADER_RE = /^\s*\[([^\]]+?)\]\s*(?:#.*)?$/;

function stripInlineComment(line: string): string {
  // Strip from `#` to end of line. For our use case (table headers and
  // hook feature assignments), keys/values don't contain quoted `#`.
  const idx = line.indexOf('#');
  return idx < 0 ? line : line.slice(0, idx);
}

function isCommented(line: string): boolean {
  return line.trimStart().startsWith('#');
}

/**
 * Returns the table name if this line is a table header (e.g. `[features]`),
 * or `null` otherwise. Tolerates surrounding whitespace and trailing inline
 * comments. Subtable headers like `[features.foo]` return `'features.foo'`.
 */
function tableHeaderName(line: string): string | null {
  if (isCommented(line)) return null;
  const m = TABLE_HEADER_RE.exec(line);
  return m ? m[1].trim() : null;
}

interface FlagSearchResult {
  /** Line index of an active (non-commented) hook feature assignment that
   *  belongs to the `[features]` table, or -1 if none. */
  lineIdx: number;
  /** Matched key (`hooks` or legacy `codex_hooks`). */
  key?: string;
  /** Raw value text after `=` (e.g. `"true"`, `"false"`, `'"yes"'`). */
  value?: string;
  /** True if matched as a top-level dotted key `features.hooks = ...`,
   *  false if matched as plain `hooks = ...` inside `[features]`. */
  dotted?: boolean;
}

/**
 * Finds the active assignment that maps to `features.hooks` in TOML.
 *
 * Recognises both:
 *   - Plain `hooks = X` inside an active `[features]` table.
 *   - Top-level dotted `features.hooks = X` (table-independent).
 *   - Legacy `codex_hooks` forms, so upgrades remove the deprecated key.
 *
 * Ignores commented lines and assignments under any other table (e.g. an
 * unrelated `[some_other]` block that happens to have its own hook key).
 */
function findFeaturesHooksFlag(lines: string[]): FlagSearchResult {
  let currentTable = ''; // '' = root / no table

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommented(line)) continue;

    const tableName = tableHeaderName(line);
    if (tableName !== null) {
      currentTable = tableName;
      continue;
    }

    const stripped = stripInlineComment(line).trim();
    if (!stripped) continue;

    // Top-level dotted form is table-independent.
    if (currentTable === '') {
      const dotted = DOTTED_FLAG_RE.exec(stripped);
      if (dotted) {
        return {
          lineIdx: i,
          key: dotted[1],
          value: dotted[2].trim(),
          dotted: true,
        };
      }
    }

    // Plain assignment only counts when we're inside [features].
    if (currentTable === 'features') {
      const plain = PLAIN_FLAG_RE.exec(stripped);
      if (plain) {
        return {
          lineIdx: i,
          key: plain[1],
          value: plain[2].trim(),
          dotted: false,
        };
      }
    }
  }
  return { lineIdx: -1 };
}

/**
 * Returns the line index of the first active `[features]` header, or -1.
 * Tolerates leading/trailing whitespace and trailing inline comments.
 */
function findFeaturesHeaderIdx(lines: string[]): number {
  return lines.findIndex((l) => tableHeaderName(l) === 'features');
}

/**
 * Ensures `.codex/config.toml` has `[features] hooks = true`.
 *
 * Cases handled (in order):
 *   1. File missing → write minimal config with only the features block.
 *   2. Active `hooks = true` already maps to `features` (either
 *      `[features]\nhooks = true` or top-level `features.hooks = true`) → no-op.
 *   3. Active `hooks = <other>` or legacy `codex_hooks = <any>` maps to
 *      `features` → replace key/value in place (no duplicate key, no invalid TOML).
 *   4. `[features]` header exists but no hook feature key under it →
 *      insert `hooks = true` immediately after the header.
 *   5. No `[features]` header anywhere → append a new `[features]` block.
 *
 * Important: hook feature assignments under any *other* table (e.g.
 * `[some_other_tool]\nhooks = true`) are NOT treated as the feature flag
 * — that is a different key and we must not rewrite it.
 *
 * Returns true if the file was created or modified, false if no change was
 * needed.
 */

/**
 * The exact contents AI Context writes when creating `.codex/config.toml`
 * from scratch. Used both for fresh installs and for ownership detection on
 * uninstall: a config file that matches this byte-for-byte was unambiguously
 * created by us and is safe to delete on uninstall. Any deviation means the
 * file is user-owned (or user-modified) and we must leave it alone.
 *
 * If you change this content, the existing-install detection will no longer
 * recognise files written by older versions. Add a backwards-compatible
 * comparison in `isAiContextScaffold()` if you bump it.
 */
const AI_CONTEXT_SCAFFOLD =
  '# AI Context — Codex configuration\n' +
  '# The `hooks` feature flag is required for the Codex CLI to load\n' +
  '# hooks defined in `.codex/hooks.json`.\n' +
  '# See: https://developers.openai.com/codex/hooks\n\n' +
  `${FEATURES_HEADER}\n${FEATURE_FLAG_LINE}\n`;

const LEGACY_AI_CONTEXT_SCAFFOLD =
  '# AI Context — Codex configuration\n' +
  '# The `codex_hooks` feature flag is required for the Codex CLI to load\n' +
  '# hooks defined in `.codex/hooks.json`.\n' +
  '# See: https://developers.openai.com/codex/hooks\n\n' +
  `${FEATURES_HEADER}\n${LEGACY_FEATURE_FLAG_KEY} = true\n`;

/**
 * True if the file content is exactly the scaffold AI Context writes on a
 * fresh install. Tolerates a missing trailing newline (some tools normalise
 * line endings) but otherwise requires an exact match — any user edit causes
 * this to return false, so we err on the side of preserving user content.
 */
function isAiContextScaffold(raw: string): boolean {
  return (
    raw === AI_CONTEXT_SCAFFOLD ||
    raw === AI_CONTEXT_SCAFFOLD.replace(/\n$/, '') ||
    raw === LEGACY_AI_CONTEXT_SCAFFOLD ||
    raw === LEGACY_AI_CONTEXT_SCAFFOLD.replace(/\n$/, '')
  );
}

export async function ensureCodexHooksFeatureFlag(
  configPath: string,
  dryRun: boolean,
): Promise<boolean> {
  const minimalContent = AI_CONTEXT_SCAFFOLD;

  // Case 1: file missing → write minimal config.
  if (!existsSync(configPath)) {
    if (!dryRun) {
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, minimalContent, 'utf8');
    }
    return true;
  }

  const raw = await readFile(configPath, 'utf8');
  const lines = raw.split('\n');

  const existing = findFeaturesHooksFlag(lines);

  // Case 2: an active features.hooks = true already exists → no-op.
  if (
    existing.lineIdx >= 0 &&
    existing.key === FEATURE_FLAG_KEY &&
    existing.value === 'true'
  ) {
    return false;
  }

  let updated: string;

  if (existing.lineIdx >= 0) {
    // Case 3: replace value in place. Use the matching regex so we only swap
    // the value portion (preserves leading whitespace and the key form).
    const replaceRe = existing.dotted
      ? /^(\s*features\.)(hooks|codex_hooks)(\s*=\s*).+$/
      : /^(\s*)(hooks|codex_hooks)(\s*=\s*).+$/;
    lines[existing.lineIdx] = lines[existing.lineIdx].replace(
      replaceRe,
      `$1${FEATURE_FLAG_KEY}$3true`,
    );
    updated = lines.join('\n');
  } else {
    // No active assignment under [features]. Look for an existing [features]
    // header (tolerant of whitespace and trailing comments).
    const headerIdx = findFeaturesHeaderIdx(lines);
    if (headerIdx >= 0) {
      // Case 4: insert flag right after the [features] header
      const before = lines.slice(0, headerIdx + 1);
      const after = lines.slice(headerIdx + 1);
      updated = [...before, FEATURE_FLAG_LINE, ...after].join('\n');
    } else {
      // Case 5: append a new [features] block at end
      const trimmed = raw.endsWith('\n') ? raw : raw + '\n';
      updated = `${trimmed}\n${FEATURES_HEADER}\n${FEATURE_FLAG_LINE}\n`;
    }
  }

  if (!dryRun) {
    await writeFile(configPath, updated, 'utf8');
  }
  return true;
}

/**
 * Removes AI Context's hook entries from .codex/hooks.json during uninstall.
 * Leaves user-owned hooks untouched. Returns true if anything was removed.
 *
 * If only the keys we wrote on fresh install remain (an empty object after
 * the `hooks` key is gone, or no other top-level keys), the file is deleted
 * so uninstall removes everything AI Context created.
 */
export async function removeCodexHooks(
  targetDir: string,
  dryRun = false,
): Promise<boolean> {
  const hooksPath = join(targetDir, '.codex', 'hooks.json');
  if (!existsSync(hooksPath)) return false;

  const raw = await readFile(hooksPath, 'utf8');
  if (!ALL_HOOK_SCRIPTS.some((name) => raw.includes(name))) return false;

  let config: CodexHooksFile;
  try {
    config = JSON.parse(raw);
  } catch {
    return false;
  }

  const hooks = config.hooks;
  if (!hooks) return false;

  let removedAny = false;

  for (const event of Object.keys(hooks)) {
    const arr = hooks[event];
    if (!Array.isArray(arr)) continue;
    const filtered = withoutOurHooks(arr);
    if (JSON.stringify(filtered) !== JSON.stringify(arr)) removedAny = true;
    if (filtered.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = filtered;
    }
  }

  if (Object.keys(hooks).length === 0) {
    delete config.hooks;
  }

  if (!removedAny) return false;

  // Codex hooks.json is written by us as `{ "hooks": {...} }` (no top-level
  // `version`). If there are no other top-level keys after the cleanup, the
  // file is purely our stub — delete it.
  const remainingKeys = Object.keys(config);
  const isOurStub = remainingKeys.length === 0;

  if (!dryRun) {
    if (isOurStub) {
      await rm(hooksPath, { force: true });
    } else {
      await writeFile(hooksPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    }
  }

  return true;
}

/**
 * Removes the AI Context scaffold from `.codex/config.toml` during uninstall.
 *
 * **Conservative ownership rule**: this function only deletes the file if
 * its contents are an EXACT byte-for-byte match for the scaffold AI Context
 * writes on a fresh install (see `AI_CONTEXT_SCAFFOLD`). Any deviation —
 * whether the user authored the file before AI Context was installed, has
 * since added their own keys, or merely added a comment — causes this
 * function to leave the file untouched.
 *
 * Why this is the right boundary:
 *   - On uninstall we cannot tell apart a `hooks = true` line we
 *     INSERTED into a pre-existing user file vs one we WROTE FRESH. Only
 *     the fresh-write case is unambiguously ours to remove.
 *   - The Codex CLI requires `[features] hooks = true` to load any
 *     hooks at all. Removing a user-owned flag would silently disable
 *     hooks the user actually wanted — even hooks that have nothing to do
 *     with AI Context.
 *   - Worst case: AI Context appended a `[features]` section to a
 *     pre-existing user config. On uninstall that line is left behind.
 *     This is a tiny visible leak with NO functional consequence — the
 *     flag with no AI Context scripts to invoke is a no-op for Codex.
 *
 * Returns true if the scaffold file was deleted, false otherwise.
 */
export async function removeCodexHooksFeatureFlag(
  targetDir: string,
  dryRun = false,
): Promise<boolean> {
  const configPath = join(targetDir, '.codex', 'config.toml');
  if (!existsSync(configPath)) return false;

  const raw = await readFile(configPath, 'utf8');
  if (!isAiContextScaffold(raw)) {
    // User-authored or user-modified content. Do not touch.
    return false;
  }

  if (!dryRun) {
    await rm(configPath, { force: true });
  }
  return true;
}
