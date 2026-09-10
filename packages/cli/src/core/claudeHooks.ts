import { cp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

/**
 * Script names we install into .claude/hooks/. Used to detect our hook entries
 * in settings.json (both to avoid duplicates on upgrade and to clean up on uninstall).
 */
const HOOK_SCRIPTS = {
  stop: 'session-log-check.sh', // Legacy: remove on upgrade/uninstall.
  preCompact: 'pre-compact.sh',
  postCompact: 'context-reminder.sh',
  postCompactLegacy: 'post-compact-reminder.sh', // Legacy name: remove on upgrade/uninstall.
  sessionEnd: 'session-end-capture.sh',
} as const;

const ALL_HOOK_SCRIPTS: string[] = Object.values(HOOK_SCRIPTS);

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
}

interface HooksBlock {
  [event: string]: HookEntry[];
}

/**
 * Builds the hooks block AI Context installs into .claude/settings.json.
 * See docs: https://code.claude.com/docs/en/hooks
 */
function buildHookCommand(scriptName: string): string {
  // Claude sets CLAUDE_PROJECT_DIR for hooks. The git/pwd fallback keeps the
  // command usable in manual and non-git smoke tests.
  return `bash "\${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}/.claude/hooks/${scriptName}"`;
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
  const rel = `.claude/hooks/${scriptName}`;
  // Walk up from CWD using shell builtins only. `git rev-parse` here would be
  // unbounded and runs BEFORE bash starts the script, so a slow git would mean
  // no capture at all — and CWD is not guaranteed to be the repository root.
  // Exits 0 when nothing is found: a session must never fail to end here.
  const walk = `d="$PWD"; while [ -n "$d" ] && [ ! -f "$d/${rel}" ]; do d="\${d%/*}"; done; [ -n "$d" ] && exec bash "$d/${rel}"; exit 0`;
  return `bash -c '${walk}'`;
}

/**
 * Claude hook `timeout` is in SECONDS, not milliseconds (the previous 5000/10000
 * values meant 83 minutes / 2.8 hours). SessionEnd hooks additionally share a
 * 1.5s budget that a longer per-hook timeout RAISES, up to 60s — so an oversized
 * value there can delay session exit. Values below are deliberate seconds.
 */
function buildHooksBlock(): HooksBlock {
  return {
    PreCompact: [
      {
        matcher: 'manual',
        hooks: [
          {
            type: 'command',
            command: buildHookCommand(HOOK_SCRIPTS.preCompact),
            timeout: 30,
          },
        ],
      },
      {
        matcher: 'auto',
        hooks: [
          {
            type: 'command',
            command: buildHookCommand(HOOK_SCRIPTS.preCompact),
            timeout: 30,
          },
        ],
      },
    ],
    // SessionEnd fires once per session (Stop fires once per TURN — that was the
    // original bug). It cannot inject context, so it captures to disk instead.
    //
    // Every documented exit reason is matched, `resume` included: the point is a
    // seamless handoff, so a session that ends to be resumed — possibly in a
    // different agent — must leave a breadcrumb too. `other` is Claude's own
    // catch-all, so this covers the full documented set.
    SessionEnd: [
      {
        matcher: 'clear|resume|logout|prompt_input_exit|other',
        hooks: [
          {
            type: 'command',
            command: buildSessionEndCommand(HOOK_SCRIPTS.sessionEnd),
            timeout: 5,
          },
        ],
      },
    ],
    SessionStart: [
      {
        matcher: 'startup|resume|compact',
        hooks: [
          {
            type: 'command',
            command: buildHookCommand(HOOK_SCRIPTS.postCompact),
            timeout: 10,
          },
        ],
      },
    ],
  };
}

export interface HooksInstallResult {
  hooksCopied: boolean;
  settingsMerged: boolean;
  settingsSkipReason?: string;
  /** Which hook events had our entries added (or would be added, in dry-run). */
  eventsMerged: string[];
}

/**
 * Installs Claude Code hooks into the target project.
 * - Copies .claude/hooks/*.sh from bundled templates.
 * - Merges AI Context hook entries (PreCompact, SessionStart; retiring legacy Stop) into
 *   .claude/settings.json per-event, preserving any existing user-owned hooks.
 */
export async function installClaudeHooks(
  templateClaudeDir: string,
  targetDir: string,
  dryRun = false,
): Promise<HooksInstallResult> {
  const targetClaudeDir = join(targetDir, '.claude');
  const targetHooksDir = join(targetClaudeDir, 'hooks');
  const targetSettingsPath = join(targetClaudeDir, 'settings.json');
  const templateHooksDir = join(templateClaudeDir, 'hooks');

  if (!dryRun) {
    await mkdir(targetHooksDir, { recursive: true });
    if (existsSync(templateHooksDir)) {
      await cp(templateHooksDir, targetHooksDir, { recursive: true });
    }
  }

  const mergeResult = await mergeHooksIntoSettings(targetSettingsPath, dryRun);

  return {
    hooksCopied: !dryRun,
    settingsMerged: mergeResult.merged,
    settingsSkipReason: mergeResult.skipReason,
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
    const managedPath = '.claude/hooks/' + name;
    const index = normalized.indexOf(managedPath);
    if (index < 0) return false;
    const before = normalized[index - 1];
    const after = normalized[index + managedPath.length];
    return (!before || /[\s/"']/.test(before)) && (!after || /[\s"';]/.test(after));
  }) ?? null;
}

// Remove only our handlers. User siblings retain their matcher, metadata and order.
// Matching ignores the old matcher so SessionStart can migrate without duplicates.
function withoutOurHooks(entries: HookEntry[]): HookEntry[] {
  return entries.flatMap((entry) => {
    if (!Array.isArray(entry.hooks)) return [entry];
    const hooks = entry.hooks.filter((handler) => ourScriptInCommand(handler.command) === null);
    if (hooks.length === entry.hooks.length) return [entry];
    return hooks.length ? [{ ...entry, hooks }] : [];
  });
}

async function mergeHooksIntoSettings(
  settingsPath: string,
  dryRun: boolean,
): Promise<MergeResult> {
  const ours = buildHooksBlock();

  // Case 1: no settings.json yet → write ours fresh.
  if (!existsSync(settingsPath)) {
    if (!dryRun) {
      await mkdir(dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, JSON.stringify({ hooks: ours }, null, 2) + '\n', 'utf8');
    }
    return { merged: true, eventsMerged: Object.keys(ours) };
  }

  const raw = await readFile(settingsPath, 'utf8');

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(raw);
  } catch {
    return { merged: false, skipReason: 'settings.json is not valid JSON', eventsMerged: [] };
  }

  const existingHooks = (settings.hooks as HooksBlock | undefined) ?? {};
  const mergedHooks: HooksBlock = { ...existingHooks };

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

  const merged = { ...settings, hooks: mergedHooks };

  if (!dryRun) {
    await writeFile(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  }

  return { merged: true, eventsMerged };
}

/**
 * Removes AI Context's hook entries (any of Stop / PreCompact / SessionStart
 * referring to our scripts) from .claude/settings.json during uninstall.
 * Leaves user-owned hooks untouched.
 */
export async function removeHookFromSettings(
  targetDir: string,
  dryRun = false,
): Promise<boolean> {
  const settingsPath = join(targetDir, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return false;

  const raw = await readFile(settingsPath, 'utf8');
  if (!ALL_HOOK_SCRIPTS.some((name) => raw.includes(name))) return false;

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(raw);
  } catch {
    return false;
  }

  const hooks = settings.hooks as HooksBlock | undefined;
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
    delete settings.hooks;
  }

  if (!removedAny) return false;

  // If the file has no remaining top-level keys, it was created by us on a
  // fresh install (we wrote `{ "hooks": {...} }`) — delete it so uninstall
  // really removes everything AI Context-owned. User-owned keys like
  // `permissions` keep the file alive.
  const isOurStub = Object.keys(settings).length === 0;

  if (!dryRun) {
    if (isOurStub) {
      await rm(settingsPath, { force: true });
    } else {
      await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    }
  }

  return true;
}
