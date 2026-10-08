import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { missingChangelog } from '../scripts/check-changelog';
import { BEGIN_FILE, STAMP_FILE, countsAsCode, isCommit, isWip, stamp, verdict } from '../scripts/commit-gate';

vi.setConfig({ testTimeout: 60_000 }); // real git and a real node process

describe('commit gate: which commands it looks at', () => {
  it('sees a git commit, also with options before the verb, and nothing else', () => {
    for (const yes of ['git commit -m "x"', 'cd repo && git commit -q -F -', 'git -c user.name=T commit -m x', 'git -C ../other commit --amend', 'git add -A; git commit']) expect(isCommit(yes), yes).toBe(true);
    for (const no of ['git status', 'git log --oneline', 'npm test', 'git committed', 'echo hello']) expect(isCommit(no), no).toBe(false);
  });
  it('text that only mentions a commit is not one: quotes and heredoc bodies', () => {
    for (const no of ['echo "run git commit when done"', "sed -i '11a - refuses `git commit` until the suite ran' CHANGELOG.md", "cat <<'EOF' > notes.md\nthen git commit -m x\nEOF", 'grep -n "git commit" CLAUDE.md']) expect(isCommit(no), no).toBe(false);
    expect(isCommit("git commit -q -F - <<'EOF'\nfeat: x\n\nbody mentions git commit too\nEOF")).toBe(true);
    expect(isCommit('git commit -m "docs: explain git commit"')).toBe(true);
  });
  it('a message that starts with wip: skips the gate (-m, --message or a heredoc)', () => {
    expect(isWip('git commit -m "wip: half way"')).toBe(true);
    expect(isWip("git commit --message='WIP(options): x'")).toBe(true);
    expect(isWip('git commit -q -F - <<\'EOF\'\nwip: half way\n\nbody\nEOF')).toBe(true);
    expect(isWip('git commit -m "feat: not wip: this one"')).toBe(false);
    expect(isWip('git commit -m "fix: wipe"')).toBe(false);
  });
  it('documentation does not make a green run stale', () => {
    expect(countsAsCode('src/server/index.ts')).toBe(true);
    expect(countsAsCode('CHANGELOG.md')).toBe(false);
    expect(countsAsCode('docs/SPEC.md')).toBe(false);
  });
});

describe('commit gate: the verdict', () => {
  const newest = { ms: 2000, file: 'src/a.ts' };
  it('blocks a commit when the last green full run is older than the last code change, and says what to do', () => {
    const v = verdict('git commit -m "feat: x"', newest, 1000);
    expect(v.block).toBe(true);
    expect(v.message).toContain('npm test');
    expect(v.message).toContain('src/a.ts');
  });
  it('lets it through when the run began after the change, when nothing changed, for wip and for other commands', () => {
    expect(verdict('git commit -m "feat: x"', newest, 2000).block).toBe(false);
    expect(verdict('git commit -m "feat: x"', undefined, 0).block).toBe(false);
    expect(verdict('git commit -m "wip: x"', newest, 0).block).toBe(false);
    expect(verdict('git status', newest, 0).block).toBe(false);
  });
  it('with no green run on record it says so', () => {
    expect(verdict('git commit -m "feat: x"', newest, 0).message).toContain('no green run on record');
  });
});

describe('commit gate: the hook process, in a real repository', () => {
  const dirs: string[] = [];
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
  const gate = resolve('scripts', 'commit-gate.ts');
  const run = (cwd: string, command: string) => spawnSync(process.execPath, [gate], { input: JSON.stringify({ tool_input: { command }, cwd }), env: { ...process.env, CLAUDE_PROJECT_DIR: cwd }, encoding: 'utf8' });

  it('exit 2 with the reason while the suite is stale, 0 after a full green run, 0 for wip and for anything that is not a commit', () => {
    const repo = mkdtempSync(join(tmpdir(), 'gate-'));
    dirs.push(repo);
    const git = (...a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'T');
    git('config', 'user.email', 't@example.com');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'export {};\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const x = 1;\n'); // a change after the last commit

    const blocked = run(repo, 'git commit -m "feat: x"');
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain('test-before-commit');
    expect(run(repo, 'git status').status).toBe(0);
    expect(run(repo, 'git commit -m "wip: x"').status).toBe(0);

    stamp(repo, 'begin'); // a full run begins and passes after the change
    stamp(repo, 'done');
    utimesSync(join(repo, 'src', 'a.ts'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000)); // the change is older than the run
    expect(run(repo, 'git commit -m "feat: x"').status).toBe(0);

    writeFileSync(join(repo, 'src', 'a.ts'), 'export const x = 2;\n'); // changed again after the green run
    expect(run(repo, 'git commit -m "feat: x"').status).toBe(2);
    expect(STAMP_FILE).toContain('full-suite-ok');
    expect(BEGIN_FILE).toContain('full-suite-begin');
  });
  it('a call it cannot read is never blocked', () => {
    const r = spawnSync(process.execPath, [gate], { input: 'not json', encoding: 'utf8' });
    expect(r.status).toBe(0);
  });
});

describe('changelog rule', () => {
  it('a commit that changes the product needs a CHANGELOG line; tests, scripts and docs alone do not', () => {
    expect(missingChangelog(['src/ui/options.ts'])).toBe(true);
    expect(missingChangelog(['src/ui/options.ts', 'CHANGELOG.md'])).toBe(false);
    expect(missingChangelog(['catalog/plugins-catalog.json'])).toBe(true);
    expect(missingChangelog(['prompts/main.md'])).toBe(true);
    expect(missingChangelog(['test/a.test.ts', 'scripts/shot.ts', 'package.json'])).toBe(false);
    expect(missingChangelog([])).toBe(false);
  });
});
