#!/usr/bin/env bash
# AI Context — PreCompact hook
# Fires before auto or manual context compaction (both triggers treated the same).
#
# Writes a best-effort autosave of the transcript to
#   .ai-context/sessions/YYYY-MM-DD-HHMMSS[-N]-precompact-autosave.md
# so the working context is preserved to disk before compaction drops it.
# Successful autosaves exit 0; write failures exit nonzero — the SessionStart(compact) hook in the
# next session reminds the agent to curate the autosave into a proper log.
#
# Expects CWD = project root (Claude Code sets this automatically).

set -euo pipefail

# Resolve the repo root defensively (Claude Code documents CWD=project root,
# but this keeps the script working if invoked manually from a subdirectory).
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

SESSIONS_DIR=".ai-context/sessions"

# Read stdin JSON. We only need `transcript_path` for the autosave content.
input="$(cat || true)"

extract_field() {
  # $1 = field name. Extracts `"field": "value"` at the top level.
  printf '%s' "$input" | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
}

trigger="$(extract_field trigger)"
transcript_path="$(extract_field transcript_path)"
local_transcript_ref="${transcript_path:-unknown}"
# Relativize home paths to ~/ so the autosave never records a bare /Users/<name>
# path; fall back to the passwd home dir when HOME is unset in the hook env.
home_dir="${HOME:-}"
[[ -z "$home_dir" ]] && home_dir="$(cd ~ 2>/dev/null && pwd)"
if [[ -n "$home_dir" && "$local_transcript_ref" == "$home_dir"* ]]; then
  local_transcript_ref="~${local_transcript_ref#"$home_dir"}"
fi

# Sessions dir may not exist yet (brand-new install) — just allow compaction.
[[ -d "$SESSIONS_DIR" ]] || exit 0

# Write an autosave for both manual and auto triggers.
date_str="$(date +%Y-%m-%d)"
time_str="$(date +%H%M%S)"
autosave_base="${SESSIONS_DIR}/${date_str}-${time_str}"
autosave="${autosave_base}-precompact-autosave.md"
collision=1
# Reserve the name atomically. Noclobber is scoped to this subshell so the
# body can append below. Retry only existing names, never other write errors.
while ! (set -C; : > "$autosave") 2>/dev/null; do
  if [[ ! -e "$autosave" && ! -L "$autosave" ]]; then
    printf 'AI Context: cannot create autosave: %s\n' "$autosave" >&2
    exit 1
  fi
  collision=$((collision + 1))
  autosave="${autosave_base}-${collision}-precompact-autosave.md"
done

{
  printf -- '---\n'
  printf 'autosaved: true\n'
  printf 'source: claude\n'
  printf 'trigger: %s\n' "${trigger:-unknown}"
  printf 'date: %s\n' "$date_str"
  printf 'time: %s\n' "$(date +%H:%M:%S)"
  printf 'local_transcript_ref: %s\n' "$local_transcript_ref"
  printf -- '---\n\n'
  printf '# Pre-compact autosave (Claude)\n\n'
  printf 'Context compaction (trigger: %s) fired. This file preserves a pointer to\n' "${trigger:-unknown}"
  printf 'the full transcript so information is not lost. The agent should review\n'
  printf 'this file in the next turn, write a curated session log using\n'
  printf '`.ai-context/sessions/_template.md`, then delete this autosave.\n\n'
  printf '## Transcript reference\n\nFull transcript (local JSONL): `%s`\n\n' "$local_transcript_ref"
} >> "$autosave"

if command -v jq >/dev/null 2>&1 && [[ -n "${transcript_path:-}" && -f "$transcript_path" ]]; then
  printf '## Recent turns\n\n' >> "$autosave"
  # Best-effort: dump the last 30 user/assistant messages. Tolerant of schema drift.
  tail -n 60 "$transcript_path" 2>/dev/null \
    | jq -r 'select(.type == "user" or .type == "assistant") | "### " + (.type | ascii_upcase) + "\n" + (if (.message.content | type) == "array" then (.message.content | map(.text // "") | join("\n")) else (.message.content // "") end) + "\n"' 2>/dev/null \
    >> "$autosave" || true
fi

exit 0
