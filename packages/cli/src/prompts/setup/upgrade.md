AI Context was reapplied to this repository. Previous state is backed up under .ai-context-backups/, in directories whose names start with a timestamp like YYYYMMDD-HHMMSS followed by a suffix (for example: 20250101-120000-12345).

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

FAIL-SAFE:
- If an upgrade prompt depends on backup or version metadata and it is missing, say that explicitly and stop instead of guessing.
- If something outside .ai-context seems necessary, stop and ask before doing it.

OUTPUT:
- Start by stating the detected installed AI Context version from .ai-context/manifest.json.
- Also report the previous version if it can be read from backup; otherwise report "legacy-unversioned".
- At the end, list exactly which .ai-context files were changed.
- If there were conflicts or assumptions, list them briefly. Otherwise say "No conflicts".

---

Important:
- The installer already restored likely project-owned files.
- Your job is compare-and-repair, not blind copy-back from backup.

Please do only this:
1. Read the CURRENT .ai-context/manifest.json and report:
   - version
   - schema_version
   - apply_mode
2. Identify the latest backup directory under .ai-context-backups/ by selecting the directory whose name has the greatest leading timestamp in YYYYMMDD-HHMMSS format, ignoring any suffix.
3. Read previous version data from backup in this order:
   - backup/.ai-context/manifest.json
   - backup/.ai-context/template.manifest.json
   If neither exists, report previous version as "legacy-unversioned".
4. Compare backup/.ai-context with current .ai-context.
5. Keep CURRENT AI Context-owned files:
   - .ai-context/README.md
   - .ai-context/manifest.json
   - .ai-context/project.overview.md.template
   - .ai-context/standards/project.rules.base.md
   - .ai-context/standards/project.workflow.base.md
   - .ai-context/sessions/_template.md
   - .ai-context/plans/_template.md
6. Restore or merge ONLY project-owned paths under .ai-context/** if current content is missing, regressed, or accidentally replaced. This includes custom files/directories whose names are not known in advance. At minimum review:
   - project.overview.md
   - project.structure.md
   - project.tasks.md
   - project.decisions.md
   - project.changelog.md
   - project.backlog.md
   - historical sessions in .ai-context/sessions/*.md (except _template.md)
   - historical plans in .ai-context/plans/*.md (except _template.md)
   - standards customizations in .ai-context/standards/*.md except *.base.md
   - any other custom .ai-context/** file or directory not listed as AI Context-owned
7. If legacy monolithic standards are found in backup, preserve them as:
   - .ai-context/standards/project.rules.legacy.md
   - .ai-context/standards/project.workflow.legacy.md
   Keep active local files focused on project-specific deltas.
8. Add a short upgrade note to .ai-context/project.tasks.md or .ai-context/project.changelog.md.
9. Do NOT replace placeholders/TBD text unless explicitly requested.

Done when:
- current AI Context-owned files remain current,
- project-owned context/history/customizations are preserved,
- and your summary includes installed version, previous version, changed files, and any conflicts/assumptions.
