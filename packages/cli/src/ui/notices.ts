import { log } from './logger.js';
import pc from 'picocolors';

/**
 * Codex loads `.codex/hooks.json` only after each hook is explicitly trusted —
 * installing the files is not enough. Print a prominent post-install reminder so
 * users don't end up with silently-inert hooks. Claude/Cursor need no equivalent
 * per-hook approval, so this is Codex-only.
 */
export function printCodexHookTrustReminder(): void {
  log.blank();
  log.warn('Codex hooks installed — trust them, or they will not run:');
  log.info(`  • Codex CLI:  run ${pc.bold('/hooks')} in this project and approve the AI Context entries`);
  log.info(`  • Codex app:  ${pc.bold('Settings → Hooks')} → trust the project-level hooks`);
  log.info(pc.dim('  Until trusted, Codex skips compaction autosaves, session-end capture, and session-start reminders.'));
  log.info(pc.dim('  If Codex was already open, restart it (or re-open the project) first.'));
}
