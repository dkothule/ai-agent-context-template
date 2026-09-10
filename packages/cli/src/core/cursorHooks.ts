import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

/**
 * Script names we install into .cursor/hooks/. Used to detect our hook entries
 * in hooks.json (both to avoid duplicates on upgrade and to clean up on uninstall).
 *
 * Scripts themselves are copied by `copyTemplates` (since AGENT_FILES.cursor includes
 * the entire `cursor/` directory). This module only manages the hooks.json merge.
 */
const HOOK_SCRIPTS = {
  preCompact: 'pre-compact.sh',
  sessionEndLegacy: 'session-log-check.sh', // Legacy: remove on upgrade/uninstall.
  sessionEnd: 'session-end-capture.sh',
  sessionStart: 'context-reminder.sh',
  sessionStartLegacy: 'post-compact-reminder.sh', // Legacy name: remove on upgrade/uninstall.
} as const;

const ALL_HOOK_SCRIPTS: string[] = Object.values(HOOK_SCRIPTS);

/** Cursor hook entry — `{ "command": "bash ..." }`. No matcher/type/timeout. */
interface CursorHookEntry {
  command: string;
}

interface CursorHooksFile {
  version?: number;
  hooks?: Record<string, CursorHookEntry[]>;
  [key: string]: unknown;
}

/**
 * Builds the hooks block AI Context installs into .cursor/hooks.json.
 * See docs: https://cursor.com/docs/hooks
 */
function buildHookCommand(scriptName: string): string {
  return `bash "$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.cursor/hooks/${scriptName}"`;
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
  const rel = `.cursor/hooks/${scriptName}`;
  // Walk up from CWD using shell builtins only. `git rev-parse` here would be
  // unbounded and runs BEFORE bash starts the script, so a slow git would mean
  // no capture at all — and CWD is not guaranteed to be the repository root.
  // Exits 0 when nothing is found: a session must never fail to end here.
  const walk = `d="$PWD"; while [ -n "$d" ] && [ ! -f "$d/${rel}" ]; do d="\${d%/*}"; done; [ -n "$d" ] && exec bash "$d/${rel}"; exit 0`;
  return `bash -c '${walk}'`;
}

function buildHooksBlock(): Record<string, CursorHookEntry[]> {
  return {
    preCompact: [{ command: buildHookCommand(HOOK_SCRIPTS.preCompact) }],
    sessionStart: [{ command: buildHookCommand(HOOK_SCRIPTS.sessionStart) }],
    // Fire-and-forget per Cursor docs: output is discarded, so capture to disk.
    sessionEnd: [{ command: buildSessionEndCommand(HOOK_SCRIPTS.sessionEnd) }],
  };
}

export interface CursorHooksInstallResult {
  /** True if scripts are present in `.cursor/hooks/` (copied by copyTemplates). */
  hooksCopied: boolean;
  configMerged: boolean;
  configSkipReason?: string;
  /** Which hook events had our entries added (or would be added, in dry-run). */
  eventsMerged: string[];
}

/**
 * Installs Cursor hooks into the target project.
 *
 * Scripts (`.cursor/hooks/*.sh`) are copied by `copyTemplates` as part of the
 * `cursor/` agent directory copy. This function only writes/merges
 * `.cursor/hooks.json` programmatically — keeping it out of the template tree
 * ensures `copyTemplates` never overwrites a user's customised hooks.json.
 */
export async function installCursorHooks(
  templateCursorDir: string,
  targetDir: string,
  dryRun = false,
): Promise<CursorHooksInstallResult> {
  const targetCursorDir = join(targetDir, '.cursor');
  const targetHooksDir = join(targetCursorDir, 'hooks');
  const targetHooksJson = join(targetCursorDir, 'hooks.json');

  // Confirm scripts are present (they should be — copyTemplates ran first).
  // We don't re-copy here because including hooks.json in templates would risk
  // overwriting user customisations on upgrade.
  void templateCursorDir;
  const hooksCopied = existsSync(join(targetHooksDir, HOOK_SCRIPTS.preCompact));

  if (!dryRun) {
    await mkdir(targetCursorDir, { recursive: true });
  }

  const mergeResult = await mergeHooksIntoConfig(targetHooksJson, dryRun);

  return {
    hooksCopied,
    configMerged: mergeResult.merged,
    configSkipReason: mergeResult.skipReason,
    eventsMerged: mergeResult.eventsMerged,
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
    const managedPath = '.cursor/hooks/' + name;
    const index = normalized.indexOf(managedPath);
    if (index < 0) return false;
    const before = normalized[index - 1];
    const after = normalized[index + managedPath.length];
    return (!before || /[\s/"']/.test(before)) && (!after || /[\s"';]/.test(after));
  }) ?? null;
}

// Remove only our handlers. User siblings retain their matcher, metadata and order.
// Matching ignores the old matcher so SessionStart can migrate without duplicates.
function withoutOurHooks(entries: CursorHookEntry[]): CursorHookEntry[] {
  return entries.filter((entry) => ourScriptInCommand(entry.command) === null);
}

async function mergeHooksIntoConfig(
  hooksPath: string,
  dryRun: boolean,
): Promise<MergeResult> {
  const ours = buildHooksBlock();

  // Case 1: no hooks.json yet → write ours fresh.
  if (!existsSync(hooksPath)) {
    if (!dryRun) {
      await mkdir(dirname(hooksPath), { recursive: true });
      await writeFile(
        hooksPath,
        JSON.stringify({ version: 1, hooks: ours }, null, 2) + '\n',
        'utf8',
      );
    }
    return { merged: true, eventsMerged: Object.keys(ours) };
  }

  const raw = await readFile(hooksPath, 'utf8');

  let config: CursorHooksFile;
  try {
    config = JSON.parse(raw);
  } catch {
    return { merged: false, skipReason: 'hooks.json is not valid JSON', eventsMerged: [] };
  }

  const existingHooks = config.hooks ?? {};
  const mergedHooks: Record<string, CursorHookEntry[]> = { ...existingHooks };

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

  const merged: CursorHooksFile = {
    version: config.version ?? 1,
    ...config,
    hooks: mergedHooks,
  };

  if (!dryRun) {
    await writeFile(hooksPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  }

  return { merged: true, eventsMerged };
}

/**
 * Removes AI Context's hook entries from .cursor/hooks.json during uninstall.
 * Leaves user-owned hooks untouched. Returns true if anything was removed.
 *
 * If after removal the file is a "stub" — only the `version` field we wrote
 * on fresh install (or an empty object) — the file is deleted entirely so
 * uninstall actually removes everything AI Context created. Files with any
 * remaining user content are preserved.
 */
export async function removeCursorHooks(
  targetDir: string,
  dryRun = false,
): Promise<boolean> {
  const hooksPath = join(targetDir, '.cursor', 'hooks.json');
  if (!existsSync(hooksPath)) return false;

  const raw = await readFile(hooksPath, 'utf8');
  if (!ALL_HOOK_SCRIPTS.some((name) => raw.includes(name))) return false;

  let config: CursorHooksFile;
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

  // If only `version` remains (or the object is empty), the file was created
  // by us on a fresh install — delete it so nothing AI Context-owned lingers.
  const remainingKeys = Object.keys(config).filter((k) => k !== 'version');
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
