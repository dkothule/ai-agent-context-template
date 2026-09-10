import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const context = new URL('../../src/templates/ai-context/', import.meta.url);
const projectFiles = readdirSync(context).filter((name) => /^project\..*\.md$/.test(name));

describe('template privacy boundary', () => {
  it('includes the expected project-owned stubs', () => {
    expect(projectFiles.sort()).toEqual([
      'project.backlog.md', 'project.changelog.md', 'project.decisions.md',
      'project.overview.md', 'project.structure.md', 'project.tasks.md',
    ]);
  });

  it.each(projectFiles)('%s stays generic', (name) => {
    const text = readFileSync(new URL(name, context), 'utf8');
    expect(text).toMatch(/\[(?:To be filled[^\]]*|YYYY-MM-DD)\]/);
    expect(text).not.toMatch(/dkothule|\/Users\/|\bv1\.\d+\.\d+\b/i);
    // A literal date is allowed only inside an explicit bracketed stub.
    const withoutStubs = text.replace(/\[[^\]\n]*\]/g, '');
    expect(withoutStubs).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
  });

  it('packs no private history, logs, or local configuration', () => {
    // Inspect npm's actual file selection without invoking lifecycle scripts.
    // npm test supplies npm_execpath on Windows as well as Unix.
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error('Run this packaging check through npm test.');
    const packed = JSON.parse(execFileSync(process.execPath, [
      npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts',
    ], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      encoding: 'utf8',
      env: { ...process.env, npm_config_update_notifier: 'false' },
    })) as Array<{ files: Array<{ path: string }> }>;
    const files = packed[0].files.map(({ path }) => path);
    expect(files).toContain('src/templates/ai-context/project.overview.md');
    const allowedHistory = new Set([
      'src/templates/ai-context/sessions/.gitkeep',
      'src/templates/ai-context/sessions/_template.md',
      'src/templates/ai-context/sessions/_archive/README.md',
      'src/templates/ai-context/sessions/_archive/.gitkeep',
      'src/templates/ai-context/plans/_template.md',
    ]);
    for (const path of files) {
      if (/(?:^|\/)(?:sessions|plans)\//.test(path)) {
        expect(allowedHistory.has(path), `Private history packed: ${path}`).toBe(true);
      }
      if (/(?:^|\/)logs\//.test(path)) {
        expect(['src/templates/ai-context/logs/README.md', 'src/templates/ai-context/logs/.gitkeep']).toContain(path);
      }
      expect(path).not.toMatch(/(?:^|\/)(?:\.ai-context|\.git|\.env)(?:\/|$)|settings\.local\.json$|(?:cursor|codex)\/hooks\.json$|codex\/config\.toml$/);
    }
  }, 30_000);
});
