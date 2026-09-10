import { mkdir, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import { readManifest, writeManifest, readSourceManifest } from './manifest.js';
import { detectApplyMode } from './applyMode.js';
import { createBackupDir, backupPath } from './backup.js';
import { copyTemplates } from './copyTemplates.js';
import { installClaudeHooks } from './claudeHooks.js';
import { installCursorHooks } from './cursorHooks.js';
import type { CursorHooksInstallResult } from './cursorHooks.js';
import { installCodexHooks } from './codexHooks.js';
import type { CodexHooksInstallResult } from './codexHooks.js';
import { renameLegacyStandards } from './legacyStandards.js';
import { restoreProjectOwnedFiles } from './restore.js';
import { appendGitignoreEntries } from './gitignore.js';
import { writeCommandLog, isoStamp } from './logWriter.js';
import type { AgentId } from './copyTemplates.js';
import type { Manifest, ApplyMode } from './manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const TEMPLATES_DIR = join(__dirname, '..', '..', 'src', 'templates');

/**
 * Read the CLI package's own name from package.json at runtime.
 * Single source of truth — when the package is renamed or scoped, no code
 * elsewhere needs to change. Used when writing `managed_by` into adopters'
 * manifest.json so the recorded installer name always matches reality.
 */
function getOwnPackageName(): string {
  try {
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
    return pkg.name ?? 'ai-context';
  } catch {
    return 'ai-context';
  }
}

/** Paths managed by the installer (relative to target project root). */
/**
 * Hook scripts AI Context used to ship and no longer does. `cp -r` copies over
 * the template but never deletes, so without this an upgrade leaves orphaned
 * scripts in the target's hooks directory forever. Their config entries are
 * removed by each agent's hook migration; this removes the files.
 *
 * Only ever add names AI Context itself shipped — never anything user-authored.
 */
const RETIRED_HOOK_SCRIPTS = [
  'session-log-check.sh',       // retired 1.2.2: reminder moved to session start
  'post-compact-reminder.sh',   // renamed 1.2.2 -> context-reminder.sh
];

const AGENT_HOOK_DIR: Record<string, string> = {
  claude: '.claude/hooks',
  cursor: '.cursor/hooks',
  codex: '.codex/hooks',
};

const MANAGED_PATHS = [
  '.ai-context',
  '.cursor',
  '.codex',
  '.claude/hooks',
];

const ROOT_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'];

/**
 * Deletes retired hook scripts for ONE agent, and only once that agent's config
 * migration has succeeded.
 *
 * Both constraints are load-bearing. Deleting for an agent the caller did not
 * select would strand that agent's still-valid registration pointing at a
 * missing file. Deleting before migration succeeds does the same thing when the
 * config is unparseable and the merge is skipped — the registration survives,
 * the script does not. A leftover orphan is inert; a dangling registration is a
 * broken hook.
 */
async function removeRetiredHookScripts(
  targetDir: string,
  agent: string,
  migrationOk: boolean,
  dryRun: boolean,
  onStep: (msg: string) => void,
  onSkip: (msg: string) => void,
): Promise<void> {
  const dir = AGENT_HOOK_DIR[agent];
  if (!dir) return;
  if (!migrationOk) {
    onSkip(`retired hook cleanup skipped for ${agent}: config migration did not complete`);
    return;
  }
  for (const script of RETIRED_HOOK_SCRIPTS) {
    const stale = join(targetDir, dir, script);
    if (!existsSync(stale)) continue;
    if (!dryRun) await rm(stale, { force: true });
    onStep(`Removed retired hook ${dir}/${script}`);
  }
}

/** A skipped merge is only safe to clean up after when nothing actually failed. */
function migrationSucceeded(merged: boolean, skipReason?: string): boolean {
  return merged || skipReason === 'AI Context hooks already present';
}

export interface InstallOptions {
  targetDir: string;
  agents?: AgentId[];
  gitignore?: boolean;
  dryRun?: boolean;
  onStep?: (msg: string) => void;
  onSkip?: (msg: string) => void;
  onWarn?: (msg: string) => void;
}

export interface InstallResult {
  applyMode: ApplyMode;
  version: string;
  schemaVersion: number;
  previousVersion: string | null;
  backupDir: string | null;
  restoredCount: number;
  copiedPaths: string[];
  hooksMerged: boolean;
  hooksMergeSkipReason?: string;
  hooksEventsMerged: string[];
  cursorHooksMerged?: boolean;
  cursorHooksMergeSkipReason?: string;
  cursorHooksEventsMerged?: string[];
  codexHooksMerged?: boolean;
  codexHooksMergeSkipReason?: string;
  codexHooksEventsMerged?: string[];
  gitignoreAdded: boolean;
  /** Path to the install log written under .ai-context/logs/install/ (null in dry-run). */
  logPath: string | null;
}

/**
 * Core installation logic — shared by `apply` and `init` commands.
 *
 * Installation pipeline:
 * 1. Detect apply mode
 * 2. Backup managed paths
 * 3. Copy template files
 * 4. Install Claude hooks
 * 5. Rename legacy standards
 * 6. Restore project-owned .ai-context files
 * 7. Write manifest.json
 * 8. Optionally update .gitignore
 */
export async function runInstall(options: InstallOptions): Promise<InstallResult> {
  const {
    targetDir,
    agents,
    gitignore = false,
    dryRun = false,
    onStep: userOnStep = () => {},
    onSkip: userOnSkip = () => {},
    onWarn: userOnWarn = () => {},
  } = options;

  // Capture all messages for the install log while still forwarding to the caller.
  const captured: string[] = [];
  const onStep = (msg: string) => { captured.push(`- ${msg}`); userOnStep(msg); };
  const onSkip = (msg: string) => { captured.push(`- (skip) ${msg}`); userOnSkip(msg); };
  const onWarn = (msg: string) => { captured.push(`- (warn) ${msg}`); userOnWarn(msg); };
  const startedAt = isoStamp();

  // Ensure target exists
  if (!existsSync(targetDir)) {
    if (!dryRun) await mkdir(targetDir, { recursive: true });
  }

  // 1. Read source manifest (bundled in package)
  const sourceManifest = await readSourceManifest(TEMPLATES_DIR);

  // 2. Detect apply mode
  const contextDir = join(targetDir, '.ai-context');
  const existingManifest = await readManifest(contextDir);
  const applyMode = detectApplyMode({
    hasExistingContext: existsSync(contextDir),
    existingVersion: existingManifest?.version ?? null,
    existingSchemaVersion: existingManifest?.schema_version ?? null,
    incomingVersion: sourceManifest.version,
    incomingSchemaVersion: sourceManifest.schema_version,
  });

  onStep(`Apply mode: ${applyMode}`);

  // 3. Backup managed paths
  let backupDir: string | null = null;
  if (!dryRun) {
    backupDir = await createBackupDir(targetDir);
  }

  // Back up root instruction files
  for (const file of ROOT_INSTRUCTION_FILES) {
    const existed = dryRun ? existsSync(join(targetDir, file)) : await backupPath(targetDir, file, backupDir!);
    if (existed) onStep(`Backed up ${file}`);
  }

  // Back up managed directories
  for (const rel of MANAGED_PATHS) {
    const existed = dryRun ? existsSync(join(targetDir, rel)) : await backupPath(targetDir, rel, backupDir!);
    if (existed) onStep(`Backed up ${rel}`);
  }

  // 4. Copy templates
  const copiedPaths = await copyTemplates({
    templatesDir: TEMPLATES_DIR,
    targetDir,
    agents,
    dryRun,
    onCopy: (rel) => onStep(`Copied ${rel}`),
  });

  // Determine which agents are getting installed. An undefined `agents` means
  // "use the installer default" — which today is ALL_AGENTS (set in apply/init).
  // Tests and explicit callers pass a subset, in which case agent-specific
  // hook installation is gated below.
  const agentList = agents ?? [];
  const installAll = agentList.length === 0;

  // 5. Install Claude hooks (only when claude agent selected)
  let hooksResult: { settingsMerged: boolean; settingsSkipReason?: string; eventsMerged: string[] } = {
    settingsMerged: false,
    eventsMerged: [],
  };
  if (installAll || agentList.includes('claude')) {
    const templateClaudeDir = join(TEMPLATES_DIR, 'claude');
    hooksResult = await installClaudeHooks(templateClaudeDir, targetDir, dryRun);
    if (hooksResult.settingsMerged) {
      const events = hooksResult.eventsMerged.join(', ');
      onStep(`Merged Claude hook(s) into .claude/settings.json: ${events}`);
    } else if (hooksResult.settingsSkipReason) {
      onSkip(`hooks merge skipped: ${hooksResult.settingsSkipReason}`);
    }
    await removeRetiredHookScripts(
      targetDir,
      'claude',
      migrationSucceeded(hooksResult.settingsMerged, hooksResult.settingsSkipReason),
      dryRun,
      onStep,
      onSkip,
    );
  }

  // 5b. Install Cursor hooks (only when cursor agent selected — scripts come from copyTemplates)
  let cursorHooksResult: CursorHooksInstallResult | null = null;
  if (installAll || agentList.includes('cursor')) {
    const templateCursorDir = join(TEMPLATES_DIR, 'cursor');
    cursorHooksResult = await installCursorHooks(templateCursorDir, targetDir, dryRun);
    if (cursorHooksResult.configMerged) {
      const events = cursorHooksResult.eventsMerged.join(', ');
      onStep(`Merged Cursor hook(s) into .cursor/hooks.json: ${events}`);
    } else if (cursorHooksResult.configSkipReason) {
      onSkip(`cursor hooks merge skipped: ${cursorHooksResult.configSkipReason}`);
    }
    await removeRetiredHookScripts(
      targetDir,
      'cursor',
      migrationSucceeded(cursorHooksResult.configMerged, cursorHooksResult.configSkipReason),
      dryRun,
      onStep,
      onSkip,
    );
  }

  // 5c. Install Codex hooks (only when codex agent selected — scripts come from copyTemplates)
  let codexHooksResult: CodexHooksInstallResult | null = null;
  if (installAll || agentList.includes('codex')) {
    const templateCodexDir = join(TEMPLATES_DIR, 'codex');
    codexHooksResult = await installCodexHooks(templateCodexDir, targetDir, dryRun);
    if (codexHooksResult.configMerged) {
      const events = codexHooksResult.eventsMerged.join(', ');
      onStep(`Merged Codex hook(s) into .codex/hooks.json: ${events}`);
    }
    if (codexHooksResult.featureFlagEnsured) {
      onStep('Enabled hooks feature flag in .codex/config.toml');
    }
    if (!codexHooksResult.configMerged && codexHooksResult.configSkipReason) {
      onSkip(`codex hooks merge skipped: ${codexHooksResult.configSkipReason}`);
    }
    await removeRetiredHookScripts(
      targetDir,
      'codex',
      migrationSucceeded(codexHooksResult.configMerged, codexHooksResult.configSkipReason),
      dryRun,
      onStep,
      onSkip,
    );
  }

  // 6. Rename legacy standards
  const standardsDir = join(targetDir, '.ai-context', 'standards');
  const renamedStandards = dryRun ? [] : await renameLegacyStandards(standardsDir);
  for (const f of renamedStandards) {
    onStep(`Renamed legacy standards: ${f}`);
  }

  // 7. Restore project-owned .ai-context files from backup
  let restoredCount = 0;
  if (!dryRun && backupDir) {
    const backupContextDir = join(backupDir, '.ai-context');
    restoredCount = await restoreProjectOwnedFiles(backupContextDir, contextDir);
    if (restoredCount > 0) onStep(`Restored ${restoredCount} project-owned file(s)`);
  }

  // 8. Write manifest.json
  const now = new Date().toISOString();
  const newManifest: Manifest = {
    name: 'ai-context',
    version: sourceManifest.version,
    schema_version: sourceManifest.schema_version,
    managed_by: `npm:${getOwnPackageName()}@${sourceManifest.version}`,
    installed_at: dryRun ? null : now,
    apply_mode: applyMode,
    agents_installed: agents ?? null,
    // Preserve the user's chosen CLI across upgrades/reapply. It's set later by
    // `runSetup` (after the user picks a CLI), so a fresh install leaves it null.
    configured_cli: existingManifest?.configured_cli ?? null,
    previous_version: existingManifest?.version ?? null,
    previous_schema_version: existingManifest?.schema_version ?? null,
  };

  if (!dryRun) {
    await writeManifest(contextDir, newManifest);
  }

  // Remove legacy template.manifest.json if present
  if (!dryRun) {
    const legacyManifest = join(contextDir, 'template.manifest.json');
    if (existsSync(legacyManifest)) {
      await rm(legacyManifest);
      onStep('Removed legacy template.manifest.json');
    }
  }

  // 9. Optionally update .gitignore
  let gitignoreAdded = false;
  if (gitignore) {
    gitignoreAdded = await appendGitignoreEntries(targetDir, dryRun);
    if (gitignoreAdded) onStep('Updated .gitignore');
    else onSkip('.gitignore entries already present');
  }

  // 10. Write install log (always, even on dry-run we skip the write itself)
  let logPath: string | null = null;
  if (!dryRun) {
    const logContent = buildInstallLog({
      startedAt,
      finishedAt: isoStamp(),
      targetDir,
      applyMode,
      version: sourceManifest.version,
      schemaVersion: sourceManifest.schema_version,
      previousVersion: existingManifest?.version ?? null,
      agents: agents ?? [],
      backupDir,
      restoredCount,
      copiedPaths,
      hooksResult,
      gitignoreAdded,
      stepLog: captured,
    });
    logPath = await writeCommandLog({
      targetDir,
      category: 'install',
      content: logContent,
    });
  }

  return {
    applyMode,
    version: sourceManifest.version,
    schemaVersion: sourceManifest.schema_version,
    previousVersion: existingManifest?.version ?? null,
    backupDir,
    restoredCount,
    copiedPaths,
    hooksMerged: hooksResult.settingsMerged,
    hooksMergeSkipReason: hooksResult.settingsSkipReason,
    hooksEventsMerged: hooksResult.eventsMerged,
    cursorHooksMerged: cursorHooksResult?.configMerged,
    cursorHooksMergeSkipReason: cursorHooksResult?.configSkipReason,
    cursorHooksEventsMerged: cursorHooksResult?.eventsMerged,
    codexHooksMerged: codexHooksResult?.configMerged,
    codexHooksMergeSkipReason: codexHooksResult?.configSkipReason,
    codexHooksEventsMerged: codexHooksResult?.eventsMerged,
    gitignoreAdded,
    logPath,
  };
}

interface BuildLogArgs {
  startedAt: string;
  finishedAt: string;
  targetDir: string;
  applyMode: ApplyMode;
  version: string;
  schemaVersion: number;
  previousVersion: string | null;
  agents: AgentId[];
  backupDir: string | null;
  restoredCount: number;
  copiedPaths: string[];
  hooksResult: { settingsMerged: boolean; eventsMerged: string[]; settingsSkipReason?: string };
  gitignoreAdded: boolean;
  stepLog: string[];
}

function buildInstallLog(a: BuildLogArgs): string {
  return [
    '---',
    `command: ai-context init/apply`,
    `apply_mode: ${a.applyMode}`,
    `version: ${a.version}`,
    `schema_version: ${a.schemaVersion}`,
    `previous_version: ${a.previousVersion ?? 'null'}`,
    `started_at: ${a.startedAt}`,
    `finished_at: ${a.finishedAt}`,
    '---',
    '',
    '# Install log',
    '',
    `- **Target**: \`${a.targetDir}\``,
    `- **Apply mode**: ${a.applyMode}`,
    `- **Version**: ${a.previousVersion ? `${a.previousVersion} → ${a.version}` : a.version} (schema v${a.schemaVersion})`,
    `- **Agents**: ${a.agents.length ? a.agents.join(', ') : '(none specified)'}`,
    `- **Backup**: ${a.backupDir ?? '(none)'}`,
    `- **Restored project-owned files**: ${a.restoredCount}`,
    `- **Hooks merged**: ${a.hooksResult.settingsMerged ? a.hooksResult.eventsMerged.join(', ') : `skipped (${a.hooksResult.settingsSkipReason ?? 'unknown'})`}`,
    `- **Gitignore updated**: ${a.gitignoreAdded ? 'yes' : 'no'}`,
    '',
    '## Step log',
    '',
    ...a.stepLog,
    '',
    '## Copied paths',
    '',
    ...a.copiedPaths.map((p) => `- ${p}`),
    '',
  ].join('\n');
}
