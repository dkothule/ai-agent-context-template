#!/usr/bin/env bash
# AI Context — Cursor session-end capture (sessionEnd)
#
# Repairs a promise shipped since v0.4.x: "a session log exists when the session
# ends". The retired reminder asked the agent to write one, but Cursor discards
# session-end hook output, so the ask never arrived. This writes the breadcrumb
# directly instead — no delivery channel required.
#
# Fires ONLY when today's session log is missing, matching the condition the
# retired hook used. Always exits 0 — a session must never fail to end here.
#
# ORDERING IS DELIBERATE: the essential recovery data (transcript pointer, end
# reason, timestamp) is written BEFORE any git call. Session-end budgets are
# tight — Codex 1s default / 3s max, Claude a shared 1.5s — and git has no
# inherent runtime bound. If we are killed mid-collection, the breadcrumb still
# contains what a next agent needs rather than being a zero-byte file.

set -uo pipefail

# Bounded command runner. macOS ships no `timeout` unless coreutils is present.
deadline=""
for candidate in timeout gtimeout; do
  if command -v "$candidate" >/dev/null 2>&1; then deadline="$candidate 2"; break; fi
done

SESSIONS_DIR=".ai-context/sessions"

# Root discovery must not be a git call in the common case: all three agents set
# CWD to the project root, so the context dir is usually right here. Only probe
# for a root when it is not, and bound that probe — an unbounded `git rev-parse`
# here would run BEFORE anything is written, which is the failure this ordering
# exists to prevent.
if [[ ! -d "$SESSIONS_DIR" ]]; then
  probe="${CLAUDE_PROJECT_DIR:-$PWD}"
  while [[ -n "$probe" && ! -d "$probe/$SESSIONS_DIR" ]]; do probe="${probe%/*}"; done
  [[ -n "$probe" ]] && cd "$probe" 2>/dev/null || true
fi
[[ -d "$SESSIONS_DIR" ]] || exit 0

input="$(cat || true)"
date_str="$(date +%Y-%m-%d)"

# Contract: act only when today's curated log is missing.
# Pure-bash glob rather than `find`: on Windows `find` can resolve to
# System32\find.exe, a different program entirely, and a failed lookup here
# would silently fall through to writing a redundant breadcrumb.
existing=""
shopt -s nullglob
for candidate in "$SESSIONS_DIR"/"$date_str"-*.md; do
  name="${candidate##*/}"
  [[ "$name" == "_template.md" ]] && continue
  [[ "$name" == *-autosave.md ]] && continue
  existing="$candidate"
  break
done
shopt -u nullglob
[[ -z "$existing" ]] || exit 0

time_str="$(date +%H%M%S)"
base="${SESSIONS_DIR}/${date_str}-${time_str}"
autosave="${base}-sessionend-autosave.md"
collision=1
# Atomic reservation (same contract as pre-compact.sh): retry only when the name
# already exists; any other create failure exits without overwriting.
while ! (set -C; : > "$autosave") 2>/dev/null; do
  if [[ ! -e "$autosave" && ! -L "$autosave" ]]; then
    exit 0
  fi
  collision=$((collision + 1))
  autosave="${base}-${collision}-sessionend-autosave.md"
done

# Phase 1 — essentials, no git. Node parses the payload properly: a sed-based
# extractor corrupts JSON-escaped values, and transcript paths may contain
# quotes or backslashes, which would leave an unusable recovery pointer.
node - "$input" "$autosave" "$date_str" "$SESSIONS_DIR" <<'NODE' 2>/dev/null || true
const fs = require('node:fs');
const [, , raw, target, today, sessions] = process.argv;
let input = {};
try { input = JSON.parse(raw || '{}'); } catch { /* manual invocation */ }
const home = process.env.HOME || '';
let ref = typeof input.transcript_path === 'string' ? input.transcript_path : '';
if (home && ref.startsWith(home)) ref = '~' + ref.slice(home.length);
const field = (v) => (v === undefined || v === null || v === '' ? '' : String(v));
const lines = ['---', 'autosaved: true', 'source: cursor', 'capture: session-end',
  `reason: ${field(input.reason) || 'unknown'}`, `date: ${today}`,
  `time: ${new Date().toTimeString().slice(0, 8)}`];
if (field(input.is_background_agent)) lines.push(`is_background_agent: ${input.is_background_agent}`);
if (field(input.duration_ms)) lines.push(`duration_ms: ${input.duration_ms}`);
lines.push(`local_transcript_ref: ${ref || 'unknown'}`, '---', '',
  '# Session-end autosave (Cursor)', '',
  `The session ended with no log for ${today}. Curate this into a proper session`,
  `log using \`${sessions}/_template.md\`, preserve \`local_transcript_ref\`, then`,
  'delete this file.', '', '## Transcript reference', '',
  `Full transcript (local): \`${ref || 'unknown'}\``, '');
fs.appendFileSync(target, lines.join('\n'));
NODE

# Fallback: if node is unavailable or failed, the reserved file is still empty.
# An empty breadcrumb is worse than none — it occupies a name and tells the next
# agent nothing. Write minimal frontmatter with shell builtins instead. The
# transcript pointer is not JSON-decoded here, so it is deliberately omitted.
if [[ ! -s "$autosave" ]]; then
  {
    printf -- '---\n'
    printf 'autosaved: true\nsource: cursor\ncapture: session-end\n'
    printf 'date: %s\n' "$date_str"
    printf 'time: %s\n' "$(date +%H:%M:%S 2>/dev/null || echo unknown)"
    printf 'note: node unavailable; payload fields omitted\n'
    printf -- '---\n\n# Session-end autosave\n\n'
    printf 'The session ended with no log for %s. Curate this into a session log.\n\n' "$date_str"
  } >> "$autosave" 2>/dev/null || true
fi

# Phase 2 — repository detail, best effort and bounded. Branch lives here rather
# than in the frontmatter: it needs a git call, and nothing that needs git may
# run before the essentials above are safely on disk.
{
  printf '## Repository state\n\n'
  printf 'Branch: `%s`\n\n' "$($deadline git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  printf '## Working tree at exit\n\n```\n'
  $deadline git status --short 2>/dev/null | head -40 || true
  printf '```\n\n## Changes\n\n```\n'
  $deadline git diff --stat HEAD 2>/dev/null | head -40 || true
  printf '```\n\n## Recent commits\n\n```\n'
  $deadline git log --oneline -n 5 2>/dev/null || true
  printf '```\n'
} >> "$autosave" 2>/dev/null || true

exit 0
