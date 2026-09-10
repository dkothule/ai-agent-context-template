#!/usr/bin/env bash
# AI Context — session-start log reminder and autosave curation.
# Codex also invokes this script for PostCompact, which is why the name is
# event-neutral: it surfaces whatever context needs attention at either point.
# Renamed from post-compact-reminder.sh in 1.2.2; the old name is cleaned up on
# upgrade by the installer's retired-script list. No pending work (or no sessions dir): silent exit 0.
# Uses the existing Node 18+ runtime; jq is not required for reminder delivery.
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
input="$(cat || true)"
node - "$input" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const agent = "claude";
const sessions = '.ai-context/sessions';
if (!fs.existsSync(sessions)) process.exit(0);
let input = {};
try { input = JSON.parse(process.argv[2] || '{}'); } catch { /* Manual invocation. */ }
const event = agent === 'codex' && (input.hook_event_name || input.hookEventName) === 'PostCompact'
  ? 'PostCompact' : 'SessionStart';
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const files = fs.readdirSync(sessions, { withFileTypes: true }).filter(entry => entry.isFile());
const autosaves = files.filter(entry => entry.name.endsWith('-autosave.md'))
  .flatMap(entry => {
    try { return [{ name: entry.name, mtime: fs.statSync(path.join(sessions, entry.name)).mtimeMs }]; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  });
// Newest modification time first, then descending filename by code-unit order.
// The tie-break is locale-independent and identical on macOS/Linux/Git Bash.
autosaves.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
const messages = [];
const hasLog = files.some(entry => entry.name.startsWith(`${today}-`) && entry.name.endsWith('.md')
  && !entry.name.endsWith('-autosave.md'));
// Preserve Codex PostCompact's autosave-only role; log reminders run at startup.
if (event === 'SessionStart' && !hasLog) {
  messages.push(`No log for today (${today}) yet; write one before you finish at ${sessions}/${today}-<topic>.md using ${sessions}/_template.md.`);
}
if (autosaves.length) {
  const newest = autosaves[0].name;
  // Autosaves come from two sources now: compaction and session end. Label the
  // right one, and say how many are pending — only the newest is named, but all
  // of them hold state the next agent may need.
  const kind = newest.includes('-sessionend-') ? 'a previous session end' : 'a previous compaction';
  const pending = autosaves.length > 1
    ? ` ${autosaves.length} autosaves are pending in total; curate every one, newest first, before deleting them.`
    : '';
  messages.push(`An autosave from ${kind} exists at ${sessions}/${newest}.${pending} Review it, write a proper session log using ${sessions}/_template.md, preserve source_autosave and local_transcript_ref if present, then delete the autosave.`);
}
if (!messages.length) process.exit(0);
const context = messages.join('\n\n');
const output = agent === 'cursor' ? { additional_context: context }
  : { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
process.stdout.write(JSON.stringify(output) + '\n');
NODE
