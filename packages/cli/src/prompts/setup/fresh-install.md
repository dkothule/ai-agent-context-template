AI Context was just installed in this repository.

AI Context is the shared working memory and governance layer for this repository. The goal of this first-time apply is to replace generic template text with project-specific context derived from the actual codebase, documentation, and configuration.

Apply the Shared Execution Rules below.

---

SHARED EXECUTION RULES:

STRICT SCOPE:
- Modify ONLY files under .ai-context/**.
- Do NOT modify any non-.ai-context files, including README.md, source files, tests, AGENTS.md, CLAUDE.md, .cursor/**, .codex/**, or .github/**.

OWNERSHIP:
- Treat these as AI Context-owned / installer-managed and keep the CURRENT versions:
  - .ai-context/README.md
  - .ai-context/manifest.json
  - .ai-context/project.overview.md.template
  - .ai-context/standards/project.rules.base.md
  - .ai-context/standards/project.workflow.base.md
  - .ai-context/sessions/_template.md
  - .ai-context/plans/_template.md
- Treat these as project-owned and preserve/merge carefully:
  - .ai-context/project.overview.md
  - .ai-context/project.structure.md
  - .ai-context/project.tasks.md
  - .ai-context/project.decisions.md
  - .ai-context/project.changelog.md
  - .ai-context/project.backlog.md
  - .ai-context/sessions/*.md except _template.md
  - .ai-context/plans/*.md except _template.md
  - .ai-context/standards/project.rules.md
  - .ai-context/standards/project.workflow.md
  - other language/team-specific standards under .ai-context/standards/
  - any other custom file or directory under .ai-context/** not listed as AI Context-owned above
- Never restore AI Context-owned files from backup over the current installed version.

EDITING STYLE:
- Compare first, then edit.
- Prefer minimal diffs. If a file already satisfies the requirement, leave it unchanged.
- Do NOT rewrite whole files unless the current file is clearly wrong or missing.
- Do NOT invent project facts.

PLACEHOLDER SAFETY:
- Do NOT replace "TBD", "[To be filled]", or other placeholders unless explicitly asked by the user in this session.
- Exception: during First-Time Apply, replace placeholders and obvious template defaults when the repository provides enough evidence to do so safely.

FAIL-SAFE:
- If something outside .ai-context seems necessary, stop and ask before doing it.

OUTPUT:
- Start by stating the detected installed AI Context version from .ai-context/manifest.json.
- At the end, list exactly which .ai-context files were changed.
- If there were conflicts or assumptions, list them briefly. Otherwise say "No conflicts".

---

Important:
- Analyze the repository before editing `.ai-context/**`.
- Prefer evidence from root documentation, package/build manifests, CI config, deployment config, source tree, tests, scripts, and inline docs/comments.
- Populate `.ai-context` with facts supported by the repository. If something is uncertain, use cautious wording or leave a placeholder instead of guessing.
- Do NOT edit non-`.ai-context` files during this bootstrap.

Please do only this:
1. Read .ai-context/manifest.json and report:
   - version
   - schema_version
   - apply_mode
   If apply_mode is not `fresh-install`, stop and inform the user to run: ai-context setup --print (upgrade prompt)
2. Inspect the repository outside `.ai-context/` to understand:
   - what the project does
   - primary language(s), framework(s), runtime(s), and tooling
   - key apps/services/packages and important entry points
   - test/lint/build workflows
   - notable integrations, infra, or operational constraints that are clearly documented in the repo
3. Ensure required files/directories exist:
   - .ai-context/README.md
   - .ai-context/manifest.json
   - .ai-context/project.overview.md OR .ai-context/project.overview.md.template
   - .ai-context/project.structure.md
   - .ai-context/project.tasks.md
   - .ai-context/project.decisions.md
   - .ai-context/project.changelog.md
   - .ai-context/project.backlog.md
   - .ai-context/standards/project.rules.base.md
   - .ai-context/standards/project.rules.md
   - .ai-context/standards/project.workflow.base.md
   - .ai-context/standards/project.workflow.md
   - .ai-context/sessions/_template.md
   - .ai-context/plans/_template.md
4. If .ai-context/project.overview.md is missing, create it from .ai-context/project.overview.md.template before editing it.
5. Populate or update .ai-context/project.overview.md using repository evidence:
   - project name
   - short mission / purpose
   - current scope or major components
   - primary tech stack and tooling
   - notable constraints or integrations when clearly supported by the repo
   Do NOT leave obvious default template text in place if the repository already provides enough information to replace it accurately.
6. Populate or update .ai-context/project.structure.md so it reflects the actual repository layout, major directories, important config/manifests, and key entry points.
7. Review project-owned context files and replace generic AI Context template/default content with repository-relevant baseline context where evidence exists:
   - .ai-context/project.tasks.md
   - .ai-context/project.backlog.md
   - .ai-context/project.decisions.md
   - .ai-context/project.changelog.md
   Rules:
   - Replace content copied from the AI Context source repository if it describes AI Context itself rather than the target repository.
   - Do NOT invent historical decisions, roadmaps, or active work.
   - If active tasks cannot be inferred reliably, say so plainly instead of fabricating them.
   - Add a short note in project.tasks.md or project.changelog.md that AI Context was initialized/bootstrapped for this repository.
8. Ensure local override files exist but stay lightweight:
   - .ai-context/standards/project.rules.md
   - .ai-context/standards/project.workflow.md
9. Language/testing standards — OPTIONAL, create ONLY if relevant to this repo:
   - Detect primary language(s), framework(s), and test stack from the repo evidence.
   - For EACH detected language that warrants team conventions, create `.ai-context/standards/project.<lang>.md` (e.g., `project.typescript.md`, `project.python.md`, `project.go.md`). Keep each file thin (~50–150 lines), covering ONLY the rules that aren't already in the base rules — don't duplicate `project.rules.base.md`.
   - If the repo has a non-trivial test stack, create `.ai-context/standards/project.testing.md` with test strategy, coverage expectations, and naming conventions observed in the repo.
   - Reference each created file from `.ai-context/standards/project.rules.md` so agents know to read them.
   - DO NOT create these files if the repo doesn't have substantive evidence for them (e.g., single-script projects, docs-only repos). Skipping is fine.
   - DO NOT copy rules from external sources you can't verify against this specific codebase.
10. Leave unknown placeholders/TBD text only where the repository does not provide enough evidence to fill them safely.

Done when:
- project.overview.md and project.structure.md reflect the actual repository,
- obvious template/default AI Context content has been replaced where repository evidence exists,
- required files exist,
- no non-.ai-context files were edited,
- and your summary lists changed .ai-context files only, plus any assumptions or unresolved unknowns.
