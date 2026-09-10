@AGENTS.md

## Claude Code

Claude Code reads `CLAUDE.md` (not `AGENTS.md`) — the `@AGENTS.md` import above pulls in the shared adapter so both tools use one source of truth. Claude-specific notes only below.

- **Plan mode**: use `/plan` before multi-file refactors or architectural changes. Once approved, immediately write the plan to `.ai-context/plans/YYYY-MM-DD-<topic>.md` before beginning any implementation.
- **Compaction**: a `PreCompact` hook autosaves the working transcript to `.ai-context/sessions/YYYY-MM-DD-HHMMSS[-N]-precompact-autosave.md` before every compaction (manual `/compact` or auto) to support best-effort recovery. A `SessionStart` hook (startup/resume/compact) emits a forward-looking log reminder and any autosave curation request through `additionalContext` — review the autosave, curate it into a proper session log, record the autosave filename as `source_autosave`, copy its `local_transcript_ref` if present, then delete the autosave.
- **Session end**: a `SessionEnd` hook (every exit reason, `resume` included) writes `.ai-context/sessions/YYYY-MM-DD-HHMMSS[-N]-sessionend-autosave.md` when today has no curated log — end reason, branch, working tree, diffstat, recent commits and the transcript pointer. It writes directly rather than asking, because Claude Code discards session-end hook output. Nothing is written when a log already exists. Curate it like a pre-compact autosave.
- **Permissions**: `ai-context setup`/`compact`/`check-drift` run with `--permission-mode acceptEdits` by default. Override via `--permission-mode <mode>` if you need stricter/looser permissions.
