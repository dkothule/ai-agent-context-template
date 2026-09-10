import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const templates = new URL('../../src/templates/', import.meta.url);
const copies = [
  'AGENTS.md',
  'cursor/rules/main.mdc',
  'ai-context/standards/project.rules.base.md',
  'ai-context/README.md',
];

function paths(text: string): string[] {
  return [...text.matchAll(/`((?:\.ai-context\/)?(?:project\.[\w.]+\.md|standards\/[\w.]*|sessions\/|plans\/))`/g)]
    .map((match) => match[1].replace(/^\.ai-context\//, ''))
    .sort();
}

const expectedTasks = {
  'Writing/modifying code': ['standards/project.rules.base.md', 'standards/project.rules.md'],
  'Release/history context': ['project.changelog.md'],
  'Understanding layout': ['project.structure.md'],
  'Planning non-trivial work': ['plans/', 'project.tasks.md'],
  'Language/testing': ['standards/'],
};

describe('shipped startup guidance', () => {
  it.each(copies)('%s uses the canonical tiers and bounded session selection', (copy) => {
    const text = readFileSync(new URL(copy, templates), 'utf8');
    const section = text.match(/Always read:([\s\S]*?)Then read based on task:([\s\S]*?)(?=\n## |$)/);
    expect(section, `Missing reading tiers in ${copy}`).not.toBeNull();
    const [, always, byTask] = section!;
    expect(paths(always)).toEqual(['project.overview.md', 'project.tasks.md', 'sessions/']);
    const mapping = Object.fromEntries(byTask.trim().split('\n').map((line) => {
      const [label, targets] = line.replace(/^- /, '').split(' → ');
      expect(targets, `Unrecognized task routing: ${line}`).toBeDefined();
      return [label, paths(targets)];
    }));
    expect(mapping).toEqual(expectedTasks);
    // These clauses are part of the handoff contract, beyond the file tiers.
    for (const clause of [
      'never `_archive/`, never `_template.md`',
      'Newest by filename date', '`time:` frontmatter field',
      'where absent, fall back to filename order',
      'Scan the `# Session:` heading of the other same-date logs',
      'whose topic relates to the current task',
      '"Next Steps" or "Notes For Next Agent"', 'follow the reference',
      'Read at most 3 logs unless continuation references in (c) require more',
    ]) {
      expect(always.replace(/\s+/g, ' ')).toContain(clause);
    }
  });

  it.each([
    ['AGENTS.md', 'AGENTS.md'],
    ['CLAUDE.md', 'CLAUDE.md'],
    ['.cursor/rules/main.mdc', 'cursor/rules/main.mdc'],
  ])('keeps public source %s synced', (source, bundled) => {
    const repo = new URL('../../../../', import.meta.url);
    expect(readFileSync(new URL(bundled, templates), 'utf8')).toBe(
      readFileSync(fileURLToPath(new URL(source, repo)), 'utf8'),
    );
  });
});
