# AGENTS.md — Shared agent adapter

This file is intentionally thin. The single source of truth is `.ai-context/`, loaded on demand.

## Read First (Every Session)

All paths below are relative to `.ai-context/`.

Always read:
1. `project.overview.md` — what this project is
2. `project.tasks.md` — what is in flight, blocked, next
3. Session logs in `sessions/` — never `_archive/`, never `_template.md`:
   a. Newest by filename date. If several share that date, order by the
      `time:` frontmatter field; where absent, fall back to filename order.
   b. Scan the `# Session:` heading of the other same-date logs and read any
      whose topic relates to the current task.
   c. If that log's "Next Steps" or "Notes For Next Agent" points at earlier
      work you are continuing, follow the reference.
   Read at most 3 logs unless continuation references in (c) require more.

Then read based on task:
- Writing/modifying code → `standards/project.rules.base.md`, `standards/project.rules.md`
- Release/history context → `project.changelog.md`
- Understanding layout → `project.structure.md`
- Planning non-trivial work → `project.tasks.md`, `plans/`
- Language/testing → files in `standards/`

## Planning

Before non-trivial work (multi-session, architectural change, external dependency), write a plan to `.ai-context/plans/YYYY-MM-DD-<topic>.md` using `_template.md`. Reference the plan from `project.tasks.md` so it's discoverable. After plan approval, write the file immediately — before any implementation begins.

## Execution Contract
1. Follow `.ai-context/standards/project.rules.base.md` and `project.rules.md`.
2. One logical change per commit; tests run before commit.
3. Keep `.ai-context/` in sync with project state — route each change to the correct file:
   - New architectural decision → `project.decisions.md`
   - User-visible change → `project.changelog.md`
   - Task transition (new/done/blocked) → `project.tasks.md`
   - Plan authored → `plans/YYYY-MM-DD-<topic>.md`
   - Session close → `sessions/YYYY-MM-DD-<topic>.md`

## End-Of-Session (Mandatory)
Any repo-aware task (review, investigation, coding) is a session unless it's pure chat without repository access.

1. Write `.ai-context/sessions/YYYY-MM-DD-<topic>.md` from `_template.md`. Multiple logs per day are fine — one per topic.
2. Update `project.tasks.md`, `project.decisions.md`, `project.changelog.md` per the mapping above.

## Hooks (per-agent)

AI Context installs session-management hooks to preserve context at the two points it is otherwise lost — compaction and session end — and to remind agents to log work. Coverage by agent:

| Agent | Session-start log reminder | Pre-compact autosave | Session-end capture | Post-compact reminder |
|---|---|---|---|---|
| **Claude Code** (`.claude/settings.json`) | `SessionStart` → `additionalContext` | ✅ `PreCompact` hook | ✅ `SessionEnd` hook | ✅ `SessionStart(compact)` hook |
| **Cursor** (`.cursor/hooks.json`) | `sessionStart` → `additional_context` | ✅ `preCompact` hook | ✅ `sessionEnd` hook (not on cloud agents) | ✅ `sessionStart` hook (JSON `additional_context`) |
| **Codex** (`.codex/hooks.json`) | `SessionStart` → `additionalContext` | ✅ `PreCompact` hook | ✅ `SessionEnd` hook | ✅ `PostCompact` + `SessionStart` hooks |

The log reminder is forward-looking: if no log exists for today, write one before finishing. The table records configured context channels, not live delivery guarantees. Claude matches startup/resume/compact; Codex also retains PostCompact autosave curation.

Session-end capture does not depend on any delivery channel — all three agents discard session-end hook output, so the hook writes the breadcrumb itself. When a session ends with no log for today, it records the end reason, branch, working tree, diffstat, recent commits and the transcript pointer to `sessions/YYYY-MM-DD-HHMMSS[-N]-sessionend-autosave.md`. Nothing is written when a curated log already exists. It fires on every documented exit reason, `resume` included, so work resumed in a different agent still leaves a trail.

The session-start hook surfaces autosaves from both sources, names which kind the newest came from, and reports how many are pending so earlier breadcrumbs are not stranded.

When curating a pre-compact autosave into a normal session log, preserve the autosave filename as `source_autosave` and copy its `local_transcript_ref` when present. Older autosaves may use `transcript_ref`; copy that value into `local_transcript_ref`. The reference is a local/private fallback for recovering exact prior discussion after compaction; the curated session log remains the durable handoff. Redact `local_transcript_ref` if session logs will be shared and the local path should not be exposed.

For all agents, `ai-context setup` / `compact` / `check-drift` run the prompt non-interactively through a coding-agent CLI. They default to the CLI saved in `.ai-context/manifest.json` (`configured_cli`) — set when you pick a CLI during `init`/`setup`, changeable later with `ai-context use [cli]`. A per-run `--cli <name>` flag overrides it. If nothing is configured, they auto-detect Claude (`claude`), Codex (`codex`), or Cursor (`agent`, with fallback to legacy `cursor-agent`) on PATH. If no CLI is available or authenticated, the prompt is copied to your clipboard so you can paste it into your agent window.

## Notes
- Higher-priority system/developer/user instructions override this file.
- Do not duplicate shared standards here; update `.ai-context/standards/` instead.
