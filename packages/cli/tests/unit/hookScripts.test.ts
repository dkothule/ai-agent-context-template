import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod, utimes } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const agents = ['claude', 'cursor', 'codex'];
const bash = process.platform === 'win32' ? `${process.env.ProgramFiles}/Git/bin/bash.exe` : '/bin/bash';
const shellPath = (path: string) => path.replace(/\\/g, '/');
const quote = (path: string) => `'${shellPath(path).replace(/'/g, "'\\''")}'`;
const tool = (name: string) => execFileSync(bash, ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
let project: string;
let sessions: string;
let bin: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'hook-scripts-'));
  sessions = join(project, '.ai-context', 'sessions');
  bin = join(project, 'bin');
  await mkdir(sessions, { recursive: true });
  await mkdir(bin);
  // Controlled PATH proves reminder delivery does not depend on jq. Wrappers
  // avoid Windows symlink privileges and preserve native Git Bash utilities.
  // `bash` is needed because registered launcher commands re-exec it.
  for (const name of ['cat', 'git', 'sed', 'head', 'tail', 'sleep', 'date', 'node', 'bash']) {
    const executable = name === 'node' ? process.execPath : name === 'bash' ? bash : tool(name);
    await writeFile(join(bin, name), `#!/bin/bash\nexec ${quote(executable)} "$@"\n`, { mode: 0o755 });
  }
  env = { ...process.env, PATH: shellPath(bin) };
});
afterEach(async () => { await rm(project, { recursive: true, force: true }); });

function run(agent: string, script = 'context-reminder.sh', input = {}, extraEnv = {}) {
  const file = fileURLToPath(new URL(`../../src/templates/${agent}/hooks/${script}`, import.meta.url));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(bash, [shellPath(file)], { cwd: project, env: { ...env, ...extraEnv } });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Hook did not terminate')); }, 8_000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    child.stdin.end(JSON.stringify(input));
  });
}
const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
const contextOf = (agent: string, stdout: string) => {
  const json = JSON.parse(stdout);
  if (agent === 'cursor') {
    expect(Object.keys(json)).toEqual(['additional_context']);
    return json.additional_context as string;
  }
  expect(json.hookSpecificOutput.hookEventName).toBe('SessionStart');
  return json.hookSpecificOutput.additionalContext as string;
};

describe.each(agents)('%s shell hooks', agent => {
  it.each([false, true])('four-state JSON output with jq available=%s', async jqPresent => {
    if (jqPresent) {
      // This hook must not invoke jq, even if it is available.
      await writeFile(join(bin, 'jq'), '#!/bin/bash\necho unexpected-jq >&2\nexit 99\n', { mode: 0o755 });
    }
    for (const [log, autosave] of [[false, false], [true, false], [false, true], [true, true]]) {
      const logPath = join(sessions, `${today()}-work.md`);
      const autoPath = join(sessions, `${today()}-120001-2-precompact-autosave.md`);
      if (log) await writeFile(logPath, 'Real log'); else await rm(logPath, { force: true });
      if (autosave) await writeFile(autoPath, 'Autosave'); else await rm(autoPath, { force: true });
      const result = await run(agent);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      if (log && !autosave) expect(result.stdout).toBe(''); // Neither: silent success.
      else {
        const context = contextOf(agent, result.stdout);
        expect(context.includes('write one before you finish')).toBe(!log);
        expect(context.includes('preserve source_autosave and local_transcript_ref')).toBe(autosave);
      }
    }
  });

  it('mixed-name discovery uses mtime, and equal-mtime tie-break is deterministic', async () => {
    const legacy = '2026-09-08-1312-precompact-autosave.md';
    const modern = '2026-09-08-131205-2-precompact-autosave.md';
    await writeFile(join(sessions, legacy), 'legacy');
    await writeFile(join(sessions, modern), 'modern');
    await utimes(join(sessions, legacy), 1000, 1000);
    await utimes(join(sessions, modern), 900, 900);
    expect(contextOf(agent, (await run(agent)).stdout)).toContain(legacy);
    await utimes(join(sessions, modern), 1100, 1100);
    expect(contextOf(agent, (await run(agent)).stdout)).toContain(modern);
    await utimes(join(sessions, modern), 1000, 1000);
    expect(contextOf(agent, (await run(agent)).stdout)).toContain([legacy, modern].sort().at(-1));
  });

  it('concurrent-collision reserves distinct complete payloads at a frozen second', async () => {
    const sync = join(project, 'sync');
    await mkdir(sync);
    await writeFile(join(bin, 'date'), `#!/bin/bash
case "$1" in
  +%Y-%m-%d) printf '2026-09-08\\n';;
  +%H%M%S) : > "$SYNC_DIR/$TASK_ID"
    while [[ ! -e "$SYNC_DIR/go" ]]; do sleep 0.01; done
    printf '123456\\n';;
  +%H:%M:%S) printf '12:34:56\\n';;
  *) exit 88;;
esac
`, { mode: 0o755 });
    const calls = ['a', 'b'].map(id => run(agent, 'pre-compact.sh', {
      trigger: 'manual', transcript_path: `transcript-${id}.jsonl`,
    }, { SYNC_DIR: shellPath(sync), TASK_ID: id }));
    for (let tries = 0; tries < 400; tries++) {
      if ((await readdir(sync)).length === 2) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect((await readdir(sync)).sort()).toEqual(['a', 'b']);
    await writeFile(join(sync, 'go'), '');
    const results = await Promise.all(calls);
    expect(results.map(result => result.code)).toEqual([0, 0]);
    const files = (await readdir(sessions)).sort();
    expect(files).toEqual(['2026-09-08-123456-2-precompact-autosave.md', '2026-09-08-123456-precompact-autosave.md']);
    const contents = await Promise.all(files.map(file => readFile(join(sessions, file), 'utf8')));
    for (const content of contents) {
      expect(content).toContain(`source: ${agent}`);
      expect(content).toContain('## Transcript reference');
      expect(content).toMatch(/Full transcript \(local JSONL\): `transcript-[ab]\.jsonl`/);
    }
    expect(contents.filter(content => content.includes('transcript-a.jsonl'))).toHaveLength(1);
    expect(contents.filter(content => content.includes('transcript-b.jsonl'))).toHaveLength(1);
  });

  it('non-collision write failure exits without overwriting an autosave', async () => {
    const existing = join(sessions, 'old-precompact-autosave.md');
    await writeFile(existing, 'Keep me');
    // chmod is enforced on Unix; Windows ACLs are not represented by chmod.
    if (process.platform === 'win32') {
      // Remove the directory after the script has passed its initial check:
      // the date wrapper supplies a nested, missing parent for allocation.
      await writeFile(join(bin, 'date'), '#!/bin/bash\nprintf "missing/parent\\n"\n', { mode: 0o755 });
    } else await chmod(sessions, 0o555);
    try {
      const result = await run(agent, 'pre-compact.sh');
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('cannot create autosave');
      expect(await readFile(existing, 'utf8')).toBe('Keep me');
      expect(await readdir(sessions)).toEqual(['old-precompact-autosave.md']);
    } finally { await chmod(sessions, 0o755); }
  });
});

it('Claude post-compaction and Codex PostCompact regression', async () => {
  await writeFile(join(sessions, '2026-09-08-121314-precompact-autosave.md'), 'Autosave');
  const claude = await run('claude', undefined, { hook_event_name: 'SessionStart', source: 'compact' });
  expect(contextOf('claude', claude.stdout)).toContain('Review it');
  const codex = await run('codex', undefined, { hook_event_name: 'PostCompact' });
  const output = JSON.parse(codex.stdout);
  expect(output.hookSpecificOutput.hookEventName).toBe('PostCompact');
  expect(output.hookSpecificOutput.additionalContext).toContain('Review it');
  expect(output.hookSpecificOutput.additionalContext).not.toContain('write one before you finish');
});

// Session-end capture. These bugs were all found by hand, not by the suite —
// nothing here executed the capture script until now.
describe('session-end capture', () => {
  const capture = 'session-end-capture.sh';
  const initRepo = async () => {
    execFileSync(bash, ['-c',
      'git init -q . && git add -A && git -c user.email=t@t -c user.name=t commit -qm init --allow-empty'],
      { cwd: project, env });
  };
  const autosaves = async () =>
    (await readdir(sessions)).filter(name => name.endsWith('-sessionend-autosave.md'));

  it.each(agents)('%s writes a breadcrumb when today has no curated log', async agent => {
    await initRepo();
    const result = await run(agent, capture, { reason: 'logout', transcript_path: '/tmp/a.jsonl' });
    expect(result.code).toBe(0);
    const files = await autosaves();
    expect(files).toHaveLength(1);
    const body = await readFile(join(sessions, files[0]), 'utf8');
    expect(body).toContain('capture: session-end');
    expect(body).toContain('reason: logout');
    expect(body).toContain('local_transcript_ref: /tmp/a.jsonl');
  });

  it.each(agents)('%s writes nothing when a curated log already exists', async agent => {
    await initRepo();
    await writeFile(join(sessions, `${today()}-existing-work.md`), '# real log\n');
    const result = await run(agent, capture, { reason: 'clear' });
    expect(result.code).toBe(0);
    expect(await autosaves()).toHaveLength(0);
  });

  it.each(agents)('%s preserves a transcript path containing JSON-escaped characters', async agent => {
    await initRepo();
    // A sed-based extractor truncated this; the pointer must survive intact.
    const tricky = '/tmp/we"ird\\path/session.jsonl';
    await run(agent, capture, { reason: 'other', transcript_path: tricky });
    const files = await autosaves();
    const body = await readFile(join(sessions, files[0]), 'utf8');
    expect(body).toContain(`local_transcript_ref: ${tricky}`);
  });

  // Spawn and kill after `ms`, resolving rather than rejecting — models an agent
  // enforcing its session-end ceiling mid-run.
  function runAndKill(agent: string, input: object, ms: number) {
    const file = fileURLToPath(new URL(`../../src/templates/${agent}/hooks/session-end-capture.sh`, import.meta.url));
    return new Promise<void>(resolve => {
      // detached so we can signal the whole group: killing bash alone leaves the
      // hanging git grandchild holding the stdio pipes, so 'close' never fires.
      const child = spawn(bash, [shellPath(file)], { cwd: project, env, detached: process.platform !== 'win32' });
      const stop = () => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { /* already gone */ }
      };
      setTimeout(stop, ms);
      // Resolve on our own schedule rather than waiting for 'close'.
      setTimeout(resolve, ms + 750);
      child.on('error', () => resolve());
      child.stdin.end(JSON.stringify(input));
    });
  }

  it.each(agents)('%s keeps essentials when git hangs and the hook is killed', async agent => {
    await initRepo();
    // Every git call hangs, including root discovery. Bounding git OUTPUT does
    // not bound its RUNTIME, so essentials must land before any git runs.
    await writeFile(join(bin, 'git'), '#!/bin/bash\nsleep 30\n', { mode: 0o755 });
    await runAndKill(agent, { reason: 'logout', transcript_path: '/tmp/hang.jsonl' }, 2_000);
    const files = await autosaves();
    expect(files).toHaveLength(1);
    const body = await readFile(join(sessions, files[0]), 'utf8');
    expect(body.length).toBeGreaterThan(100);           // not a zero-byte stub
    expect(body).toContain('local_transcript_ref: /tmp/hang.jsonl');
    expect(body).toContain('reason: logout');
  }, 15_000);

  it.each(agents)('%s records branch as bounded metadata after essentials', async agent => {
    await initRepo();
    await run(agent, capture, { reason: 'clear', transcript_path: '/tmp/b.jsonl' });
    const files = await autosaves();
    const body = await readFile(join(sessions, files[0]), 'utf8');
    expect(body).toMatch(/^Branch: `.+`$/m);
    // Branch needs git, so it must come after the transcript pointer.
    expect(body.indexOf('local_transcript_ref')).toBeLessThan(body.indexOf('Branch:'));
  });

  it.each(agents)('%s still writes a usable breadcrumb when node is unavailable', async agent => {
    await initRepo();
    await writeFile(join(bin, 'node'), '#!/bin/bash\nexit 127\n', { mode: 0o755 });
    const result = await run(agent, capture, { reason: 'logout' });
    expect(result.code).toBe(0);
    const files = await autosaves();
    const body = await readFile(join(sessions, files[0]), 'utf8');
    expect(body).toContain('capture: session-end');
    expect(body).toContain('node unavailable');
  });

  it.each(agents)('%s records essentials before touching git', async agent => {
    await initRepo();
    // Session-end budgets are tight (Codex 1s/3s, Claude a shared 1.5s) and git
    // has no inherent runtime bound. Essentials must land first so a killed hook
    // still leaves a usable breadcrumb rather than a zero-byte file.
    await run(agent, capture, { reason: 'window_close', transcript_path: '/tmp/x.jsonl' });
    const files = await autosaves();
    const body = await readFile(join(sessions, files[0]), 'utf8');
    const frontmatterEnd = body.indexOf('\n---', 3);
    const gitSection = body.indexOf('## Working tree at exit');
    expect(frontmatterEnd).toBeGreaterThan(0);
    expect(gitSection).toBeGreaterThan(frontmatterEnd);
    expect(body.indexOf('local_transcript_ref')).toBeLessThan(gitSection);
  });

  it.each(agents)('%s surfaces its breadcrumb to the next session, labelled by kind', async agent => {
    await initRepo();
    await run(agent, capture, { reason: 'logout' });
    const surfaced = await run(agent, 'context-reminder.sh', {});
    expect(contextOf(agent, surfaced.stdout)).toContain('a previous session end');
  });
});

// The launcher is part of the contract. Earlier tests spawned the script file
// directly, so an unbounded `$(git rev-parse …)` embedded in the REGISTERED
// COMMAND went unnoticed — the agent's shell evaluates it before bash ever
// starts the script, defeating every in-script protection.
describe('session-end registered command', () => {
  it.each([
    ['claude', '.claude', 'settings.json', (c: any) => c.hooks.SessionEnd[0].hooks[0].command],
    ['cursor', '.cursor', 'hooks.json', (c: any) => c.hooks.sessionEnd[0].command],
    ['codex', '.codex', 'hooks.json', (c: any) => c.hooks.SessionEnd[0].hooks[0].command],
  ])('%s launcher starts capture even when git hangs', async (agent, dir, file, pick) => {
    const install = agent === 'claude' ? (await import('../../src/core/claudeHooks.js')).installClaudeHooks
      : agent === 'cursor' ? (await import('../../src/core/cursorHooks.js')).installCursorHooks
        : (await import('../../src/core/codexHooks.js')).installCodexHooks;
    const templateDir = fileURLToPath(new URL(`../../src/templates/${agent}/`, import.meta.url));
    const hooksDir = join(project, dir, 'hooks');
    await mkdir(hooksDir, { recursive: true });
    const script = await readFile(join(templateDir, 'hooks', 'session-end-capture.sh'), 'utf8');
    await writeFile(join(hooksDir, 'session-end-capture.sh'), script, { mode: 0o755 });
    await install(templateDir, project, false);

    const config = JSON.parse(await readFile(join(project, dir, file), 'utf8'));
    const command = pick(config);
    expect(command).toContain('session-end-capture.sh');

    // Every git invocation hangs — including any the launcher itself performs.
    await writeFile(join(bin, 'git'), '#!/bin/bash\nsleep 30\n', { mode: 0o755 });
    // Run from a nested subdirectory: CWD is NOT guaranteed to be the repo root,
    // and a subdirectory fallback that shells out to git reintroduces the hang.
    const nested = join(project, 'src', 'deep', 'nested');
    await mkdir(nested, { recursive: true });
    await new Promise<void>(resolve => {
      const child = spawn(bash, ['-c', command], {
        cwd: nested, env, detached: process.platform !== 'win32',
      });
      setTimeout(() => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { /* already gone */ }
      }, 2_000);
      setTimeout(resolve, 2_750);
      child.on('error', () => resolve());
      child.stdin.end(JSON.stringify({ reason: 'logout', transcript_path: '/tmp/launch.jsonl' }));
    });

    const files = (await readdir(sessions)).filter(n => n.endsWith('-sessionend-autosave.md'));
    expect(files).toHaveLength(1);
    const body = await readFile(join(sessions, files[0]), 'utf8');
    expect(body).toContain('local_transcript_ref: /tmp/launch.jsonl');
  }, 20_000);
});
