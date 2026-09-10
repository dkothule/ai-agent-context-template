# ai-context Architecture

`ai-context` solves a single problem: **coding agents lose context when you switch between them or start a new session.** This document explains how the tool works end-to-end — the file layout it imposes, how agents consume it, and how the CLI operates on it.

For usage, see the [README](../README.md). This doc is for contributors and for readers who want to understand the design before adopting the tool.

---

## System overview

```mermaid
flowchart TB
  cli[ai-context CLI]
  claude[Claude Code]
  cursor[Cursor]
  codex[Codex]

  subgraph proj[Your project]
    direction TB
    adapters["Thin adapter wrappers<br/><br/>CLAUDE.md<br/>AGENTS.md<br/>.cursor/rules/main.mdc"]
    hooks["Agent hooks<br/><br/>.claude/hooks/ + settings.json<br/>.cursor/hooks/ + hooks.json<br/>.codex/hooks/ + hooks.json"]
    ctx["<b>.ai-context/</b><br/>single source of truth<br/><br/>project.*.md<br/>standards/<br/>plans/<br/>sessions/<br/>logs/"]
  end
  
  cli -- install / upgrade --> adapters
  cli -- install --> hooks
  cli -- check-drift / compact --> ctx

  claude -- hook callbacks --> hooks
  cursor -- hook callbacks --> hooks
  codex -- hook callbacks --> hooks
  hooks -- write autosaves --> ctx

  claude -- read on session start --> adapters
  cursor -- read on session start --> adapters
  codex -- read on session start --> adapters
  adapters -- redirect to --> ctx

  claude -- read & write on demand --> ctx
  cursor -- read & write on demand --> ctx
  codex -- read & write on demand --> ctx

```

**Principles encoded in this diagram:**

- **One shared directory**, not per-agent configs. `.ai-context/` is the authoritative state.
- **Thin adapters**. Agent-specific files contain pointers, not content. Keeps context windows clean.
- **Hooks are invisible glue**. Claude Code, Cursor, and Codex hooks fire automatically to preserve context at both points it is otherwise lost — compaction and session end; users don't invoke them.
- **The CLI is orthogonal**. Agents work without the CLI once installed. The CLI is only for install, maintenance (drift, compact), and removal.

---

## Install / upgrade flow

Running `ai-context init` (or the non-interactive `ai-context apply`) walks through a backup-then-copy-then-restore pipeline designed to never destroy user content.

```mermaid
flowchart TD
  A[user runs ai-context init] --> B{existing<br/>.ai-context/<br/>manifest.json?}
  B -->|no| C[apply_mode = fresh-install]
  B -->|yes| D{incoming version ==<br/>existing version?}
  D -->|yes| E[apply_mode = reapply]
  D -->|no| F[apply_mode = upgrade]

  C --> G[no backup needed]
  E --> H
  F --> H[backup MANAGED_PATHS<br/>to .ai-context-backups/ts/<br/>with preserveTimestamps]

  G --> I[copy template files<br/>→ target project]
  H --> I

  I --> J[install selected-agent hooks<br/>Claude settings.json<br/>Cursor hooks.json<br/>Codex hooks.json + config.toml]
  J --> K[restore project-owned files<br/>from backup by ownership pattern<br/>with preserveTimestamps]
  K --> L[write updated manifest.json<br/>version, schema, previous_version]
  L --> M[run setup prompt via<br/>detected CLI claude / cursor / codex]
  M --> N[write install log to<br/>.ai-context/logs/install/ts.md]
  N --> O[write setup log to<br/>.ai-context/logs/setup/ts.md]
```

**Key properties:**

- **Every run is recoverable.** Backups land in `.ai-context-backups/<timestamp>/` before any overwrite.
- **Additive hook merge.** The installer adds missing hook events without touching hooks the user owns. Claude settings, Cursor hooks, and Codex hooks are all merged rather than blindly overwritten.
- **Ownership-based restore.** `project.overview.md` (project-owned) is restored from backup; `project.rules.base.md` (tool-owned) is not. See [File ownership model](#file-ownership-model) below.
- **Timestamps preserved.** `fs.cp` runs with `preserveTimestamps: true` in both backup and restore so session-log age tracking survives upgrades. Without this, `ai-context compact` would see every file as brand new after each upgrade.

---

## Agent session lifecycle

Every agent that reads `.ai-context/` follows the same tiered protocol on session start, and the same end-of-session writeback discipline.

```mermaid
sequenceDiagram
  participant User
  participant Agent as Claude / Cursor / Codex
  participant Ctx as .ai-context/

  User->>Agent: start session

  rect rgb(235, 245, 255)
    note over Agent,Ctx: Session start — tiered reads (always)
    Agent->>Ctx: read project.overview.md
    Agent->>Ctx: read project.tasks.md
    Agent->>Ctx: read recent sessions/*.md<br/>(exclude _archive/ and _template.md, bounded selection)
  end

  User->>Agent: task (code / refactor / review)

  rect rgb(255, 245, 230)
    note over Agent,Ctx: On-demand reads — based on task type
    Agent->>Ctx: standards/project.rules.{base,}.md<br/>(when writing code)
    Agent->>Ctx: project.changelog.md<br/>(for release/history context)
    Agent->>Ctx: project.tasks.md + plans/<br/>(when planning non-trivial work)
    Agent->>Ctx: project.structure.md<br/>(when navigating the tree)
  end

  Agent->>User: response / code changes

  rect rgb(235, 255, 235)
    note over Agent,Ctx: Session end — writebacks
    Agent->>Ctx: sessions/YYYY-MM-DD-topic.md (new log)
    Agent->>Ctx: project.tasks.md (status updates)
    Agent->>Ctx: project.decisions.md (new ADR)
    Agent->>Ctx: project.changelog.md (release-notes entry)
  end
```

**Why tiered, not all-at-once:** agents have finite context windows. Loading every standards file up front would consume the budget that should go toward the actual code and conversation. The tiered protocol front-loads orientation (always-read) and defers everything else to on-demand reads based on the current task.

### Three project files, three time horizons

The always-read list includes `project.overview.md`, `project.tasks.md`, and recent session logs. The changelog is read for release/history context; the backlog is consulted when grooming future work. Each file serves a different time horizon:

| File | Horizon | What it holds | Update cadence |
|---|---|---|---|
| `project.tasks.md` | **Now** — active work | In-progress, blocked, next-up. Concrete and actionable. | Often (per-session) |
| `project.backlog.md` | **Later** — ideas pipeline | Deferred work, feature ideas, tech debt. Not yet ready to start. | Occasionally (when grooming) |
| `project.changelog.md` | **Past** — shipped history | Immutable record of releases, organized by version. User-visible changes only. | On release boundaries |

The lifecycle of an idea flows in one direction: `backlog.md` → (when work begins) `tasks.md` → (when done) possibly `changelog.md` under a version heading.

Session-start orientation combines overview (what this project is), tasks (active, blocked, and next work), and recent sessions (decisions and handoffs). The changelog provides shipped history when the task needs it. Keep task status current so the next agent can distinguish pending work from completed work.

### Bounded selection of recent session logs

Start with the newest filename date in `sessions/`, excluding `_archive/` and `_template.md`. For same-date logs, order by the `time:` frontmatter field, falling back to filename order where it is absent. Scan other same-date `# Session:` headings and read related topics. Follow earlier-session references in "Next Steps" or "Notes For Next Agent" when continuing work. Read at most three logs unless those continuation references require more.

This selection uses the documented date/time and relevance rules, not filesystem modification time or a strict one-file limit. `ai-context compact` archives old sessions into `sessions/_archive/YYYY-MM-rollup.md` to keep the active set manageable. Pending autosaves are separately surfaced by the session-start hook for curation.

### Which writebacks are mandatory

A new session log and updated task status happen every session. `project.decisions.md` gets a new ADR only when the session made a non-trivial architectural choice worth explaining later. `project.changelog.md` gets an entry only for changes a downstream consumer of the project would care about (new features, user-visible fixes, breaking changes) — internal refactors don't belong there. Agents are expected to judge each case; when in doubt, err toward logging.

---

## Context-preservation flow (Claude Code hooks)

Context is lost at two points: when the window compacts, and when a session ends. A hook covers each.

Claude Code's context window compacts when it fills up — either automatically near the token limit, or manually via `/compact`. Compaction is lossy by nature: the agent receives a summary, not the full transcript. `ai-context` installs three hooks: two that turn compaction into a safe checkpoint, and one that captures state when a session ends without a log.

```mermaid
sequenceDiagram
  participant User
  participant Claude as Claude Code
  participant PC as pre-compact.sh<br/>(PreCompact hook)
  participant FS as .ai-context/<br/>sessions/
  participant PCR as post-compact-<br/>reminder.sh<br/>(SessionStart hook)

  User->>Claude: /compact<br/>or auto-compact triggers

  rect rgb(255, 240, 220)
    note over Claude,PC: PreCompact hook fires
    Claude->>PC: spawn with JSON on stdin<br/>(transcript_path, trigger)
    PC->>FS: write YYYY-MM-DD-HHMMSS[-N]-<br/>precompact-autosave.md<br/>+ transcript excerpt via jq
    PC-->>Claude: exit 0 (never blocks)
  end

  Claude->>Claude: compact context<br/>(summarize, drop oldest)

  rect rgb(220, 240, 255)
    note over Claude,PCR: SessionStart(compact) hook fires
    Claude->>PCR: spawn on fresh post-compact session
    PCR->>FS: glob for *-autosave.md<br/>(pre-compact and session-end)
    PCR-->>Claude: emit additionalContext<br/>"autosave exists — curate it"
  end

  Claude->>User: session continues, agent aware of autosave

  rect rgb(220, 255, 220)
    note over Claude,FS: Curation (in next agent turn)
    Claude->>FS: read the autosave file
    Claude->>FS: write sessions/YYYY-MM-DD-topic.md<br/>(curated session log)
    Claude->>FS: delete the autosave
  end
```

### Session-end capture

Compaction is not the only way context is lost — a session that simply ends leaves nothing behind. `SessionEnd` (Claude), `sessionEnd` (Cursor) and `SessionEnd` (Codex) fire once per session and **cannot inject context**; all three vendors discard their output. So this hook does not ask the agent to write a log, it writes the breadcrumb itself, which needs no delivery channel.

```mermaid
sequenceDiagram
  participant Agent as Agent (any of 3)
  participant SE as session-end-capture.sh
  participant FS as .ai-context/<br/>sessions/

  Agent->>SE: session ends (any exit reason)
  SE->>FS: today's curated log present?
  alt log exists
    SE-->>Agent: exit 0, write nothing
  else no log
    SE->>FS: reserve filename atomically
    SE->>FS: write essentials first<br/>(reason, time, transcript pointer)
    SE->>FS: append git detail<br/>(branch, tree, diffstat, commits)
    SE-->>Agent: exit 0
  end
```

Two constraints shape it. Session-end budgets are the tightest in the system — Codex caps at 1s default / 3s max, Claude shares a 1.5s budget — and git has no inherent runtime bound. So essentials are written *before* any git call, and root discovery uses shell builtins only, in both the script and the registered launcher command. A hook killed at the ceiling still leaves a usable breadcrumb rather than an empty file.

**Design decisions:**

- **Both manual and auto triggers run the same path.** An earlier design blocked manual `/compact` to force a session log first; that friction wasn't worth it. The autosave captures context regardless of trigger.
- **Session-start reminders use configured context channels.** Claude uses `SessionStart(startup|resume|compact)` with `additionalContext`; Cursor uses `sessionStart` with `additional_context`; Codex uses `SessionStart(startup|resume)` with `additionalContext` and retains `PostCompact` autosave curation. A missing daily log prompts “write one before you finish.” Configuration/output tests establish the emitted fields, not live vendor delivery.
- **Autosave names are reserved atomically.** Seconds plus a collision suffix prevent overwrite. Discovery uses modification time, then descending filename order for ties, via the existing Node runtime.
- **Autosaves preserve a breadcrumb, not the durable record.** The autosave stores a `local_transcript_ref` pointer to the local transcript JSONL and, when possible, a recent-turn excerpt. The post-compact session should copy `source_autosave` and `local_transcript_ref` into the curated session log before deleting the autosave, so exact prior discussion remains recoverable locally if the compacted summary missed a critical detail. Older autosaves may use the legacy field name `transcript_ref`; curators should normalize that to `local_transcript_ref`. Hooks write the path home-relative when possible, but because `local_transcript_ref` is still local/private, teams that commit or share session logs may redact it.
- **Capture writes, reminders ask.** The two concerns run on different channels because only one of them can carry the message. Session start has a documented context channel, so the reminder lives there. Session end has none, so capture writes to disk instead. Cursor's `sessionEnd` does not fire for cloud agents, so capture does not run there; breadcrumbs record `is_background_agent` to make that visible.
- **Graceful `jq` degradation.** If `jq` isn't installed, the autosave still writes a stub with a pointer to the transcript JSONL path. Context isn't lost even in minimal environments.

---

## Drift detection (`check-drift`) and auto-apply (`--fix`)

`.ai-context/` can drift from the actual codebase as the project evolves. `check-drift` detects drift in two layers and optionally applies patches.

```mermaid
flowchart TB
  A[ai-context check-drift<br/>--fix=significant] --> B[Layer 1 — static checks<br/>local, fast, no LLM]
  B --> B1[broken refs in<br/>project.structure.md]
  B --> B2[stale overview<br/>last_updated vs git log]
  B --> B3[stale In-Progress tasks<br/>no commits in 14 days]
  B --> B4[backlog items > 90 days old]

  B1 & B2 & B3 & B4 --> C[Layer 2 — LLM analysis<br/>via claude -p]
  C --> D[agent reads overview +<br/>structure + decisions +<br/>git log --stat -n 50 + tree]
  D --> E[agent produces structured<br/>report with severity tags<br/>significant / moderate / minor]
  E --> F[write to<br/>.ai-context/logs/drift/<br/>ts-drift.md]

  F --> G{--fix flag?}
  G -->|no| H[done — terminal shows path]
  G -->|yes| I[Phase 2 — apply]
  I --> J[second claude -p invocation<br/>reads the report file]
  J --> K[agent applies patches at or<br/>above --fix severity cutoff]
  K --> L[agent reports<br/>files edited + skipped]
```

**Severity cutoff semantics:**

| Flag | Applies |
|---|---|
| `--fix` (default) | `[significant]` only |
| `--fix=significant` | `[significant]` only |
| `--fix=moderate` | `[significant]` + `[moderate]` |
| `--fix=minor` | everything |
| `--fix=all` | everything (alias for `minor`) |

**Why file-first:** storing the report to disk lets `--fix` (Phase 2) read it deterministically, lets users re-run just the apply step later, and provides an audit trail. Without a file, users had to copy-paste ~200-line reports from terminal scrollback into a fresh session to apply anything.

---

## Session compaction flow

Session logs accumulate. After months of use, there can be hundreds — too many for "read the latest session" to remain useful. `compact` archives old sessions into a single rollup and deletes the originals.

```mermaid
flowchart LR
  A[ai-context compact<br/>--older-than 30<br/>--keep 10] --> B[scan<br/>.ai-context/sessions/]
  B --> C[exclude _template.md +<br/>precompact-autosave +<br/>_archive/]
  C --> D[sort by mtime<br/>newest → oldest]
  D --> E[always preserve<br/>newest --keep files]
  E --> F[filter remaining<br/>by > --older-than days]
  F --> G{matches?}
  G -->|none| H[exit<br/>nothing to archive]
  G -->|yes| I[build rollup prompt<br/>source list + template +<br/>deletion instructions]
  I --> J[agent via claude -p]
  J --> K[agent reads each session]
  K --> L[agent writes<br/>sessions/_archive/<br/>YYYY-MM-rollup.md]
  L --> M[agent deletes source files]
  M --> N[write compact log to<br/>logs/compact/ts.md]
```

**The rollup is structured, not a dump.** The prompt instructs the agent to extract (not copy) three classes of preserved content:

- Decisions carried forward (still in effect)
- Open threads at end of range (unresolved work)
- File/area knowledge (non-obvious context about specific files)

Source sessions are then deleted. Rollup file has `archived: true` frontmatter and the `_archive/` folder's README tells agents not to read it at session start — so rollups are reference material, not current state.

---

## File ownership model

Every file under `.ai-context/` is either **tool-owned** (shipped by `ai-context`, replaced on upgrade) or **project-owned** (your content, preserved across upgrades).

| Path | Ownership | On upgrade |
|---|---|---|
| `.ai-context/manifest.json` | Tool | Rewritten with new version/schema metadata |
| `.ai-context/README.md` | Tool | Replaced with new version |
| `.ai-context/project.overview.md.template` | Tool | Replaced (fallback for `project.overview.md`) |
| `.ai-context/standards/project.rules.base.md` | Tool | Replaced |
| `.ai-context/standards/project.workflow.base.md` | Tool | Replaced |
| `.ai-context/standards/README.md` | Tool | Replaced |
| `.ai-context/sessions/_template.md` | Tool | Replaced |
| `.ai-context/sessions/_archive/README.md` | Tool | Replaced |
| `.ai-context/plans/_template.md` | Tool | Replaced |
| `.ai-context/logs/README.md` | Tool | Replaced |
| `.ai-context/project.overview.md` | Project | Restored from backup |
| `.ai-context/project.tasks.md` | Project | Restored from backup |
| `.ai-context/project.decisions.md` | Project | Restored from backup |
| `.ai-context/project.changelog.md` | Project | Restored from backup |
| `.ai-context/project.backlog.md` | Project | Restored from backup |
| `.ai-context/project.structure.md` | Project | Restored from backup |
| `.ai-context/standards/project.rules.md` | Project | Restored from backup |
| `.ai-context/standards/project.workflow.md` | Project | Restored from backup |
| `.ai-context/standards/project.<lang>.md` | Project | Restored from backup (created by `init` setup prompt on first install) |
| `.ai-context/sessions/*.md` | Project | Restored from backup |
| `.ai-context/plans/*.md` | Project | Restored from backup |
| `.ai-context/sessions/_archive/*.md` | Project | Restored from backup |
| Any other custom file under `.ai-context/**` | Project | Restored from backup |

The **restore logic** (`restoreProjectOwnedFiles` in `packages/cli/src/core/restore.ts`) walks the backup tree, checks each file against `isAiContextOwned()`, and restores any that aren't tool-owned. Custom files users add (e.g., their own `project.typescript.md` or domain-specific context files) are preserved by default — no explicit allowlist needed.

---

## Hook source of truth

Hook behavior is split between script templates and generated configuration:

| Artifact | Source of truth | Packaged/installed behavior |
|---|---|---|
| Claude hook scripts | `.claude/hooks/*.sh` at repo root | `scripts/sync-templates.sh` copies them to `packages/cli/src/templates/claude/hooks/`; `installClaudeHooks()` copies scripts and merges `.claude/settings.json` |
| Cursor hook scripts | `.cursor/hooks/*.sh` at repo root | `scripts/sync-templates.sh` copies them to `packages/cli/src/templates/cursor/hooks/`; `copyTemplates()` installs scripts and `installCursorHooks()` writes/merges `.cursor/hooks.json` |
| Codex hook scripts | `.codex/hooks/*.sh` at repo root | `scripts/sync-templates.sh` copies them to `packages/cli/src/templates/codex/hooks/`; `copyTemplates()` installs scripts and `installCodexHooks()` writes/merges `.codex/hooks.json` and `.codex/config.toml` |

Generated hook config files are intentionally not template-owned for Cursor and Codex. `scripts/sync-templates.sh` removes `cursor/hooks.json`, `codex/hooks.json`, and `codex/config.toml` from the package template tree so upgrades can merge into a user's existing config instead of overwriting it.

Codex project-level hooks live under the project's `.codex/` layer and are loaded for trusted projects, but project trust and hook trust are separate. After `.codex/hooks.json` is added or changed, run `/hooks` inside Codex for that project and trust the AI Context entries. Codex stores trust per hook hash in `~/.codex/config.toml`; newly added or changed events such as `PreCompact` and `PostCompact` will not run until reviewed. If a Codex Desktop session was already running before `.codex/hooks.json` was added or changed, restart the app/session or re-open the project before reviewing the hooks.

---

## Command-level reference

All commands live in `packages/cli/src/commands/` and share a small set of core modules:

| Command | Primary logic | Log output |
|---|---|---|
| `init` / `apply` | `core/install.ts`, `core/copyTemplates.ts`, `core/claudeHooks.ts`, `core/cursorHooks.ts`, `core/codexHooks.ts`, `core/restore.ts` | `.ai-context/logs/install/` |
| `setup` | `core/setupFlow.ts`, `core/agentCLI.ts` | `.ai-context/logs/setup/` |
| `use` | `commands/useCli.ts`, `core/manifest.ts` | (none — terminal only) |
| `check-drift` | `commands/checkDrift.ts` + static checks inline | `.ai-context/logs/drift/` |
| `compact` | `commands/compact.ts` | `.ai-context/logs/compact/` |
| `uninstall` | `commands/uninstall.ts` | (none — terminal only) |
| `status` | `commands/status.ts` | (none — terminal only) |
| `version` | `commands/version.ts` | (none — terminal only) |

Shared primitives used by the LLM-driven commands (`setup`, `check-drift`, `compact`):

- **`core/agentCLI.ts`** — thin public barrel re-exporting the agent-CLI subsystem under `core/cli/`:
  `cli/types.ts` (CLIConfig + parser types), `cli/format.ts` (progress-label helpers),
  `cli/vendors/{claude,codex,cursor}.ts` (one module per CLI: command shape + stream parsers,
  the most vendor-volatile code, unit-tested via `tests/unit/cli/<vendor>-parser.test.ts`),
  `cli/registry.ts` (the `CLI_REGISTRY` + spec/progress accessors), `cli/detection.ts`
  (binary resolution + health checks), `cli/process.ts` (generic spawn), `cli/runner.ts`
  (streaming prompt execution). Adding/fixing a CLI touches only its `cli/vendors/<name>.ts`.
- **`core/clipboardFallback.ts`** — `executeOrCopy()` is the unified entry point. Tries the CLI first; on failure OR empty stdout, copies the prompt to clipboard with a clear paste hint. Does NOT fall back on permission denials alone — if stdout came through, the run counts as executed.
- **`core/logWriter.ts`** — `writeCommandLog({ category, content })` writes `.ai-context/logs/<category>/<iso-ts>.md`. Append-only across upgrades.
- **`prompts/`** — single home for all LLM prompts. Static prompts are `.md` (`prompts/setup/{fresh-install,upgrade}.md`, read at runtime); dynamic prompts are pure builder functions (`prompts/drift.ts`, `prompts/compact.ts`) that take gathered data and return strings — commands do the I/O, the prompt layer does not. Interactive (inquirer) CLI prompts are UI and live in `core/../ui/`, not here. See `src/prompts/README.md`.

**Configured CLI (`configured_cli`).** The CLI chosen during `setup` is persisted to `manifest.json` by `runSetup` (via `setConfiguredCli()`) and reused as the default for `setup`/`check-drift`/`compact` (resolved via `resolveConfiguredCli()`, which ignores a stored value no longer in the registry). It carries forward across upgrades (`core/install.ts`) and is changed independently with `ai-context use [cli]`. `--cli <name>` overrides it per run; `null` means auto-detect. It is distinct from `agents_installed` (which adapter files were written).

---

## Design principles

- **File system is the interop layer.** No daemon, no database, no cloud. Markdown files every agent and human can read, edit, grep, commit. The only stateful thing is the Claude Code transcript JSONL, and even that is a pointer (held in autosave files), not a copy.
- **Adapters are thin.** `CLAUDE.md` is one line (`@AGENTS.md`) plus a few Claude-specific notes. `AGENTS.md` is ~40 lines. Neither duplicates `.ai-context/` content. This keeps agents' context windows clean and makes the single-source-of-truth rule actually enforceable.
- **Tiered reading.** Always-read for orientation; on-demand reads for task-specific detail. Agents have finite context; this convention uses it efficiently.
- **Hooks, not humans, preserve context.** Session logging is mandatory by convention, but also backstopped by session-end reminders and PreCompact autosaves across Claude, Cursor, and Codex. Users get a working system even when their discipline slips.
- **Every action is reversible.** Backups before every install. Nested `.ai-context/.git/` supported (filter excludes it from backup/restore). All LLM-driven commands have clipboard fallback. See the [README's Safety & rollback section](../README.md#safety--rollback).
- **Ownership-based, not allowlist-based.** Project-owned files are identified by pattern, not enumerated. Custom files users add under `.ai-context/**` are preserved automatically.
- **Logs always persist.** Install, setup, drift, compact — every run writes a markdown log to `.ai-context/logs/<category>/`, regardless of outcome (executed, clipboard, printed, failed). Users can audit what the tool + their agents actually did.

---

## Extension: adding a new agent

To support a new coding agent:

1. **Add the adapter file.** A thin file pointing at `.ai-context/` in whatever format the agent expects (e.g. `.newagent/rules.md`). Mirror the tiered reading + end-of-session discipline from existing adapters.
2. **Register in `copyTemplates.ts`.** Add an entry to `AGENT_FILES` mapping the agent ID to its file(s), and to `TEMPLATE_TO_TARGET` for the path mapping.
3. **Add to `selectAgents()` in `prompts/agentSelector.ts`** so users can pick it during `init`.
4. **(Optional) Add CLI support.** If the agent has a headless CLI like `claude -p`, create `core/cli/vendors/<name>.ts` exporting a `CLIConfig` (ping/run args + stream parsers) and register it in `core/cli/registry.ts`. Add parser fixture tests under `tests/unit/cli/`. This enables `setup`, `check-drift`, `compact` to execute via that CLI instead of falling back to clipboard.

No changes to `.ai-context/` layout are needed — the whole directory is agent-agnostic by design.

---

## Further reading

- [README](../README.md) — user-facing docs and usage
- [CHANGELOG](../CHANGELOG.md) — release history of the npm package
- [LICENSE](../LICENSE) — MIT
