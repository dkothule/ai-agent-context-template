# Project Rules Base (AI Context-Owned)

This file is AI Context-owned and updated by AI Context upgrades.
Project-specific policy belongs in `project.rules.md`.

## 1) Source Of Truth
- `.ai-context/` is the shared source of truth across Codex, Claude Code, and Cursor.
- Agent-specific files (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/*.mdc`) must stay thin and must not duplicate shared governance text.

## 2) Instruction Priority
Apply instructions in this order:
1. System/developer/runtime constraints
2. User request for the current session
3. This file and other `.ai-context/standards/*` files
4. Agent-specific adapter files

If instructions conflict, follow the highest-priority source and state assumptions briefly.

## 3) Clarification And Autonomy Policy
- Proceed without asking when requirements are clear and the change is low risk.
- Ask the user before proceeding when ambiguity could materially change behavior, cost, security, data integrity, or production impact.
- If blocked, ask one concise question and propose a default option to keep momentum.

## 4) High-Risk Action Confirmation (Required)
Require explicit user confirmation before:
- Destructive data/file actions (for example: `rm -rf`, irreversible deletes, force resets)
- Production-impacting deploy/config changes
- Database schema/data migrations in non-local environments
- Security/authentication/authorization policy changes
- Large dependency/platform upgrades with broad blast radius

When asking for confirmation, state:
1. what will change,
2. why it is needed,
3. rollback/mitigation plan if available.

## 5) Session Start (Required)
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

## 6) Working Loop
1. Plan the smallest safe change that satisfies the request.
2. Implement incrementally.
3. Run relevant tests/checks.
4. Update context files when project state changes.
5. Summarize outcomes, verification, and remaining risks.

### Plans — When Required
Write a plan to `.ai-context/plans/YYYY-MM-DD-<topic>.md` (use `_template.md`) before starting work that is any of:
- Multi-session (expected to span more than one working session)
- Architectural change (new module, new data model, schema change, dependency upgrade with blast radius)
- External dependency integration (new third-party API, new CLI, new infrastructure component)
- Security-sensitive change (auth, permissions, secrets handling)

Reference the plan from `project.tasks.md` so it's discoverable. Small fixes, typos, and one-file changes don't need a plan.

## 7) Response Contract By Task Type
### Implementation/Change Tasks
- Lead with result.
- Include changed files and key commands.
- State verification performed (tests/lint/build) and what was not run.
- Mention any residual risk or follow-up.

### Code Review Tasks
- Findings first, ordered by severity.
- Include file and line references.
- Keep summary brief and secondary.
- Explicitly state if no findings were identified.

### Incident/Debug Tasks
- State impact, root cause (or current hypothesis), and mitigation status.
- Include reproduction/verification steps.
- List next actions with owners or clear handoff notes.

## 8) Context Update Rules
Route each state change to the correct `.ai-context/` file:
- New architectural decision → `project.decisions.md`
- User-visible change → `project.changelog.md`
- Task transition (new/in-progress/done/blocked) → `project.tasks.md`
- Plan authored → `plans/YYYY-MM-DD-<topic>.md`
- Session close → `sessions/YYYY-MM-DD-<topic>.md`

## 9) Session Logging (Mandatory)
Every meaningful work session must create or update a session note.

### What Counts As A Session
- Any task that reads, searches, reviews, edits, or runs commands against repository files.
- Code review, proofreading, investigation, and documentation updates count as sessions when they use repo context.
- Pure conversational Q&A with no repository access is the only default exemption.

### Session File Naming
- Format: `YYYY-MM-DD-<topic>.md`
- Example: `2026-02-17-template-normalization.md`
- If multiple sessions on same topic/day, append suffix: `YYYY-MM-DD-<topic>-02.md`

### Session Location
- `.ai-context/sessions/`

### Session Template
- Use `.ai-context/sessions/_template.md`

### Update-Existing Behavior
- If a relevant session note already exists for the same day/topic, update it instead of creating duplicate logs.

### Timestamp Standard
- Use ISO 8601-style values:
  - Date: `YYYY-MM-DD`
  - Time: `HH:MM:SS`

## 10) Quality Gates
- Do not intentionally commit untested code.
- Keep changes focused and reversible.
- Do not commit secrets or credentials.
- Remove debug-only code before finalizing.

## 11) Git Workflow
See `.ai-context/standards/project.workflow.base.md` and `.ai-context/standards/project.workflow.md`.

## 12) Multi-Agent Handoffs
Assume another agent continues your work later.
- Be explicit in session notes.
- Record key decisions and rationale.
- Leave actionable next steps.
