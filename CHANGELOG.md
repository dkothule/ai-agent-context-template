# Changelog

User-facing release notes for the `@dkothule/ai-context` npm package. This is the canonical changelog read by the publish workflow when creating GitHub Releases.

The format follows [Keep a Changelog](https://keepachangelog.com/) loosely and uses ISO 8601 dates.

***

## [1.2.2] - 2026-09-09

> **Unpublished release candidate.** September 9 is the planned publication date; confirm the actual date before publishing.

### Fixed

- **Autosave collisions** — pre-compact hooks reserve filenames atomically, using seconds and collision suffixes. Discovery picks the newest modification time with deterministic filename ties, including legacy autosaves.
- **Hook script renamed** — `post-compact-reminder.sh` is now `context-reminder.sh`. It stopped being post-compact-specific once it began firing on startup/resume, emitting the daily-log reminder, and surfacing session-end autosaves; Codex also invokes it for `PostCompact`, so the name is event-neutral. Upgrades remove the old script and its registrations automatically — a retired-script list in the installer deletes hook files AI Context no longer ships, which also clears the `session-log-check.sh` orphan left by the reminder move.
- **Session-end capture** — a session ending with no log for today now writes a `sessionend-autosave.md` breadcrumb directly (end reason, branch, working tree, diffstat, recent commits, transcript pointer) instead of asking the agent to do it. Restores a guarantee documented since v0.4.x whose mechanism never worked: the retired hook emitted a reminder that Claude Code, Cursor, and Codex all discard at session end. Fires on every exit reason, `resume` included. Cursor's `sessionEnd` does not fire for cloud agents, so capture does not run there. The session-start hook surfaces autosaves from both sources, labels which kind, and reports how many are pending.
- **Session-log reminders** — moved to session start for Claude Code, Cursor, and Codex with forward-looking wording. Upgrades remove retired Stop/sessionEnd handlers, broaden Claude’s matcher, and preserve user handlers sharing a registration. Legacy uninstall and reapply remain supported.

### Changed

- **Startup guidance** — adapters and shared rules now always read overview, active tasks, and recent sessions. Release history, layout, and standards are loaded by task. Session selection accounts for same-date logs and continuation references, with a three-log limit unless continuation requires more.
- **Setup prompts** — fresh installs and upgrades no longer require a plan just to demonstrate the convention. Plans remain required for substantive work under the shared rules.
- **Recovery documentation** — describes compaction recovery as best-effort, documents optional `jq` for transcript excerpts, and distinguishes emitted session-end reminders from delivery to the agent. Session-log reminders now run at session start; delivery claims remain qualified by configuration-level evidence.
- **Roadmap** — reconciles context loading, task handoffs, portable workflows/vendor plugins, and hook reliability priorities while retaining deferred items.
- **CI and packaging checks** — adds Node 24 to the test matrix and version-sync job (Node 24 is what `publish.yml` already builds and publishes on, so PR CI now covers it across all three operating systems), plus regression checks for startup-guidance parity and generic template packaging. Node 18+ compatibility is unchanged.

## [1.2.1] - 2026-05-31

> **Headline:** Documentation release — new README positioning ("context infrastructure for AI coding agents"), a terminal demo, and a clearer install story. No code changes; the CLI is identical to 1.2.0.

### Changed

- **README refresh** — repositioned around "context infrastructure for AI coding agents," led with the capability overview, merged the "why not just a hand-written `CLAUDE.md`" objection into the pattern section, removed a duplicate install block, and embedded a terminal demo. Cites [OpenAI's harness-engineering post](https://openai.com/index/harness-engineering/) (Feb 2026) as encouraging external validation of the thin-adapter / repo-as-system-of-record pattern this project has shipped since December 2025.
- **Install guidance** — recommends `npm install -g @dkothule/ai-context` for recurring use (commands run as `ai-context <cmd>`); `npx` is now documented as a no-install quick try only.
- **Doc accuracy** — setup/drift docs reference the configured CLI (`claude -p`, `codex exec`, or `agent --print`) instead of implying Claude-only execution.

## [1.2.0] - 2026-05-31

> **Headline:** Cursor and Codex reach near-CLI parity with Claude. `ai-context setup` / `compact` / `check-drift` now run non-interactively through the Cursor `agent` CLI in addition to `claude` and `codex`. Cursor and Codex also get session-management hook parity with Claude Code (autosave on compaction, log-reminder, and post-compact reminder for all three). Plus GitHub Releases on publish and a tracked `CHANGELOG.md`.

### Added

- **Persisted CLI agent + `ai-context use`**
  - The CLI you pick during `init`/`setup` is now saved to `.ai-context/manifest.json` as `configured_cli`, and `setup` / `check-drift` / `compact` default to it instead of always auto-detecting (which picked `claude` first). A project set up with Codex keeps using Codex.
  - `ai-context init` gained `--cli <name>`, and `--yes` is now truly non-interactive — it no longer shows the post-install CLI picker. It runs setup via `--cli` if given, else the first selected agent, and persists that choice.
  - New `ai-context use [cli]` command to change it later — bare `ai-context use` opens an interactive picker (claude/codex/cursor) defaulting to the current choice; `ai-context use codex` sets it directly. Saves your choice even if that CLI isn't installed/authenticated yet (warns, then persists).
  - The value is preserved across upgrades (`init`/`apply` no longer reset it). A per-run `--cli <name>` flag still overrides the saved default.
  - `ai-context status` now shows the configured CLI.

- **Cursor CLI execution support** (`agent --print`)
  - `ai-context setup` / `compact` / `check-drift` auto-detect the Cursor `agent` CLI on PATH and run prompts non-interactively, with `--force` to auto-accept edits and `--output-format stream-json` for streaming
  - Falls back to the legacy `cursor-agent` binary if `agent` is not installed (older builds shipped under that name)
  - Falls back further to the clipboard if no Cursor CLI is available or authenticated
  - `CLIConfig` gained `promptStyle: 'stdin' | 'positional'` and `binFallback` fields to support Cursor's positional `agent --print "{PROMPT}"` invocation pattern; `claude` and `codex` keep their stdin-based contract unchanged
  - `cursor` selectable as a target in the `init` interactive picker

- **Cursor session hooks** (`.cursor/hooks.json`)
  - `preCompact` — autosaves transcript before compaction
  - `sessionEnd` — reminds you to write a session log
  - `sessionStart` — surfaces any pending autosave for curation via Cursor's documented `additional_context` JSON field
  - Hook commands resolve via the git root so they still work if Cursor invokes hooks from a subdirectory
  - New module `cursorHooks.ts`; merges additively on upgrade

- **Codex session hooks** (`.codex/hooks.json` + `.codex/config.toml`)
  - `PreCompact` — autosaves transcript before compaction
  - `PostCompact` — surfaces the just-written autosave for curation after compaction
  - `Stop` — session-log reminder; emits documented `{"continue": true, "systemMessage": "..."}` JSON
  - `SessionStart` — surfaces any leftover autosaves; emits documented `{"hookSpecificOutput": {..., "additionalContext": "..."}}` JSON for context injection
  - `.codex/config.toml` enables the required `[features] hooks = true` flag
  - Hook commands use `$(git rev-parse --show-toplevel)` so they work when Codex starts in a subdirectory
  - Documentation now calls out Codex's separate `/hooks` review step: project trust loads `.codex/hooks.json`, but each project hook entry must be trusted before it runs
  - New module `codexHooks.ts`

- **`ai-context check-drift --fix` audit log** — Phase 2 (apply) now writes `.ai-context/logs/drift/<ts>-fix.md` with agent output and a pointer to the source drift report. Previously only Phase 1 (analysis) was logged.

- **GitHub Releases on publish** — `publish.yml` auto-creates a release after `npm publish` succeeds. Notes are extracted from this `CHANGELOG.md`.

- **`ai-context status` shows hook configs** — now reports `.cursor/hooks.json`, `.codex/hooks.json`, and `.claude/settings.json` alongside the agent adapter files.

- **Tracked `CHANGELOG.md`** — canonical release notes at the repo root (this file). Replaces reading from a project-internal file in CI.

- **Defensive `cd` in all hook scripts** — every shipped script (Claude, Cursor, Codex) starts at the git root so `.ai-context/` paths resolve even if invoked from a subdirectory.
- **Claude hook command root resolution** — `.claude/settings.json` entries now use `${CLAUDE_PROJECT_DIR}` with a `git rev-parse --show-toplevel || pwd` fallback, matching current Claude Code hook guidance and preserving non-git installs.

### Changed

- **Agent-CLI subsystem modularized for maintainability.** `core/agentCLI.ts` (an 830-line file) is now a thin public barrel; internals split into `core/cli/` with one module per vendor (`cli/vendors/{claude,codex,cursor}.ts`) owning that CLI's command shape + stream parsers. Adding or fixing a CLI now touches only its vendor module; parsers are unit-tested against event fixtures (`tests/unit/cli/`). Public API unchanged.
- **All LLM prompts consolidated under `src/prompts/`.** Static setup prompts at `src/prompts/setup/*.md`; the previously-inline `check-drift`/`compact` prompts are now pure builder functions in `src/prompts/{drift,compact}.ts`. Interactive (inquirer) CLI prompts moved to `src/ui/`. One documented home for every prompt (`src/prompts/README.md`).
- **Codex hook-trust is now hard to miss.** `init`/`apply` print a post-install reminder when Codex hooks are installed, and the README has a prominent callout: Codex only runs `.codex/hooks.json` after you trust each hook via `/hooks` (CLI) or **Settings → Hooks** (desktop app) — installing the files isn't enough. Claude/Cursor need no such per-hook approval (documented for contrast).
- **Compaction autosave docs now call out transcript recovery.** README and adapter templates explain that pre-compact autosaves include a local `local_transcript_ref` JSONL pointer, and curated session logs should preserve that pointer when present so exact prior discussion can be recovered if a compacted summary misses important context. Hook scripts write the path home-relative when possible.
- `codex` agent installer now copies a `.codex/` directory in addition to `AGENTS.md`.
- `sync-templates.sh` strips `hooks.json` (and `config.toml` for Codex) from the templates so user customisations are never overwritten on upgrade — these files are owned by the `installCursorHooks()` / `installCodexHooks()` merge logic.
- README and architecture docs now document hook source-of-truth: root hook scripts are synced into package templates, while hook registration/config files are generated or merged by the TypeScript installer modules.
- Clipboard-fallback `pasteHint` in `setup` / `compact` / `check-drift` now lists the Cursor Agent panel as a valid paste target (used when no CLI is available).
- `AGENTS.md` and `.cursor/rules/main.mdc` got a new `Hooks` section documenting per-agent coverage and updated CLI integration notes (Cursor `agent` CLI now first-class).
- README: install tree, Hooks table, and Supported agents table updated — Cursor row shows `agent --print` CLI execution.

### Removed

- **Google Antigravity adapter removed.** The `.agent/rules/rules.md` adapter was never actively tested. v1.2 focuses on the three agents with first-class CLIs — Claude Code, Cursor, Codex. `init`/`apply` no longer install `.agent/`, `--agents antigravity` is rejected, and `status` no longer lists it. Existing `.agent/` files in adopter projects are left untouched (not auto-removed).
- `gemini` removed from `CLI_REGISTRY`. It was registered speculatively but never tested.

### Fixed

- **Codex `Stop` hook output** — was plain text (invalid per Codex docs), now emits the documented JSON shape.
- **Codex hook command paths** — were repo-relative, now resolve via the git root (Codex docs explicitly recommend this).
- **`config.toml` merge is now table-aware** — only treats `hooks` under `[features]` (or top-level dotted `features.hooks`) as the feature flag. Same-named keys under other tables are left alone. Also tolerates trailing inline comments on the `[features]` header.
- **`config.toml` merge no longer creates duplicate keys** — replaces existing `hooks = false` value in place; does not append a second key (which would be invalid TOML). Legacy `codex_hooks` entries under `[features]` are migrated to `hooks` to avoid Codex deprecation warnings.
- **Claude hooks are now gated by agent selection** — previously installed unconditionally; now only when the `claude` agent is selected. Symmetric with cursor/codex installation behavior.
- **Uninstall removes everything AI Context installed** — stub `.cursor/hooks.json`, `.codex/hooks.json`, `.codex/config.toml`, and `.claude/settings.json` (when they only contained our content) are now deleted, matching the README's "remove everything" promise. Files with user-owned content remain.
- **Uninstall never touches user-owned `.codex/config.toml`** — `removeCodexHooksFeatureFlag()` now only deletes the file if its contents are an EXACT byte-for-byte match for the scaffold AI Context writes on a fresh install. A user-authored file (or a file we appended to but didn't create) is preserved verbatim. This prevents uninstall from silently disabling Codex hooks the user actually configured themselves.
- **Stale `gemini` references** in `docs/ARCHITECTURE.md` and a code comment in `clipboardFallback.ts` removed — Gemini was already removed from `CLI_REGISTRY` but lingering doc/code mentions could confuse readers.
- **Codex CLI execution uses current syntax** — replaced stale `codex -q -` invocation with `codex exec ... -`; `-p` is profile in current Codex and `-q` is rejected. Codex prompt execution now runs with `workspace-write`, `--skip-git-repo-check`, `--disable hooks`, `--ephemeral`, `--json`, and stdin prompt delivery.
- **Setup clipboard fallback is now real** — when a user selects a specific CLI and the health check reports missing or unauthenticated, `setup` copies the prompt immediately instead of warning about fallback and then trying the failed CLI anyway.
- **CLI health wording is more accurate** — temporary or quota-related health-check failures now report as "not ready right now" instead of being mislabeled as unauthenticated.
- **Agent CLIs run from the target project directory** — `setup`, `compact`, and `check-drift` now pass the target path as the spawned process cwd, so Claude, Cursor, and Codex inspect/edit the intended repository even when `ai-context <command> /path/to/project` is launched from elsewhere.
- **Codex terminal noise reduced** — non-streaming CLI output is captured for setup/compact/check-drift logs but no longer dumped directly to the terminal. Users see a spinner plus concise completion; detailed diffs remain available in `.ai-context/logs/**`.
- **Agent progress without verbose diffs** — CLI streaming now prints concise activity lines such as tool/command start/completion while suppressing aggregated command output and patch-sized diffs from the terminal. Final agent summaries are still captured in `.ai-context/logs/**`.
- **Cursor progress labels** — Cursor stream parsing now reads nested `shellToolCall` metadata so the terminal shows useful labels like `Shell: List files in workspace directory` instead of generic `Tool` lines.
- **Long-running setup expectation** — setup now tells users that agent execution can take a few minutes and that timeout falls back to clipboard. Agent execution timeout is now 10 minutes (up from 5) because Codex fresh-install setup can legitimately run longer than 5 minutes. Spinner and timeout text use human-readable minutes instead of opaque seconds, and fallback warnings no longer prepend noisy internal wording.

### Upgrade safety

No data loss for existing v1.1.3 installs. Three interlocking mechanisms:

1. Full backup of `.cursor/`, `.codex/`, `.claude/hooks/`, and `.ai-context/` before any change.
2. `hooks.json` and `config.toml` are excluded from the template tree, so `copyTemplates` cannot overwrite user-customised configs.
3. `cursorHooks.ts` and `codexHooks.ts` use additive merge — existing user entries are preserved.

***

## [1.1.3] - 2026-04-20

### Changed
- **README** refresh — polished tagline, added "Skills" and "Cursor Hooks" items to the roadmap. The new README is what appears on npm.

### Fixed
- **Publish workflow** `Verify tag is on main` — replaced shallow fetch with a full fetch so `git merge-base --is-ancestor` can walk main's history. Prior shallow fetch caused false-negative failures when a tag didn't point to main's exact HEAD (e.g. after a retag).

## [1.1.0] - 2026-04-17

### Added
- **`ai-context compact`** — archives old session logs into `.ai-context/sessions/_archive/YYYY-MM-rollup.md`. Flags: `--older-than`, `--keep`, `--dry-run`, `--print`, `--copy`, `--cli`, `--permission-mode`.
- **`ai-context check-drift`** — two-layer drift detection (static + LLM) with `--fix` for auto-applied patches.
- **PreCompact hook + SessionStart(compact) hook** for Claude Code, autosaving the working transcript before compaction and reminding the next session to curate it.
- **`.ai-context/sessions/_archive/`** directory and **`.ai-context/standards/README.md`**.
- **Plans convention** — adapter wrappers and `project.rules.base.md` now instruct agents when to write a plan to `.ai-context/plans/`.

### Changed
- `claude` CLI invocation now passes `--permission-mode acceptEdits` by default to eliminate permission-prompt stalls during LLM-executed commands.
- `CLAUDE.md` template is now a one-line `@AGENTS.md` import; both adapter files stay thin.
- `ai-context setup` grew `--copy` and `--permission-mode` flags; clipboard fallback is now automatic on CLI failure or permission denial.

### Removed
- `project.python.md` and `project.testing.md` no longer shipped by default — `init` now creates language/testing standards on demand.

### Fixed
- Nested-git-safe backup/restore: `.git` directories filtered out so projects that make `.ai-context/` its own git repo no longer risk history corruption on upgrade.
- Per-event additive merge for `.claude/settings.json` so upgrading from v1.0 adds PreCompact + SessionStart entries without touching user-owned hooks.

## [1.0.0] - 2026-03-17

### Added
- `packages/cli/` — TypeScript npm CLI (`ai-context`) published to npm.
- Interactive agent selection at `init` time.
- Commands: `ai-context init`, `apply`, `setup`, `status`, `uninstall`, `version`.
- `--gitignore` flag to add session and backup directories to `.gitignore`.
- `.ai-context/plans/` directory for design documents.
- Manifest schema v5 with `agents_installed` field.

### Changed
- `claudeHooks.ts` uses JSON parse/stringify for settings.json merge (replaces fragile bash string-trimming from the prior shell installer).
- README Quick Start now leads with `npx ai-context init`.

### Removed (from source)
- `scripts/ai-context.sh` — replaced by `npx ai-context apply`.
- `scripts/uninstall-ai-context.sh` — replaced by `npx ai-context uninstall`.

***
