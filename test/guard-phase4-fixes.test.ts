// Final-review findings of Phase 4 (guard side). Each case failed before the fix.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluate, type GuardContext } from '../src/server/guard/rules';
import { DEFAULT_SECRET_PATTERNS } from '../src/server/git/secrets';

let root: string;
let R: string;
let W: string;
let ctx: GuardContext;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'guardp4-'));
  R = join(root, 'repo');
  W = join(root, 'repo.worktrees', 'a b');
  mkdirSync(join(R, '.git', 'refs', 'tags'), { recursive: true });
  mkdirSync(join(R, '.git', 'hooks'), { recursive: true });
  writeFileSync(join(R, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(W, { recursive: true });
  ctx = { worktree: W, repo: R, branch: 'agent/p/a', projectBranch: 'project/p', secretPatterns: DEFAULT_SECRET_PATTERNS };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Call = { tool: string; input: Record<string, unknown> };
const sh = (command: string): Call => ({ tool: 'Bash', input: { command } });
const ps = (command: string): Call => ({ tool: 'PowerShell', input: { command } });
const main = (c: Call) => evaluate({ role: 'main', ...c }, { ...ctx, worktree: R });
const reviewer = (c: Call) => evaluate({ role: 'agent', ...c }, { ...ctx, readOnly: true });

const MAIN_DENY: [string, Call][] = [
  ['--no-verify with a wildcard refspec', sh('git push --no-verify origin "refs/heads/*:refs/heads/*"')],
  ['a plain wildcard refspec', sh('git push origin "*:*"')],
  ['a wildcard for tags', sh('git push --no-verify origin "refs/t*:refs/t*"')],
  ['--no-verify on a plain push', sh('git push --no-verify')],
  ['--no-verify to a project branch', sh('git push --no-verify origin project/x')],
  ['--no-verify --all', sh('git push --no-verify --all')],
  ['hooksPath through -c', sh('git -c core.hooksPath=/dev/null push origin HEAD')],
  ['hooksPath through config', sh('git config core.hooksPath /nowhere')],
  ['an alias that pushes with --no-verify', sh('git config alias.p "push --no-verify"')],
  ['an alias through -c', sh('git -c alias.p="push --no-verify" p origin HEAD:main')],
  ['send-pack', sh('git send-pack origin main')],
  ['deleting the hook', sh('rm .git/hooks/pre-push')],
  ['moving the hook away', sh('mv .git/hooks/pre-push /tmp/x')],
  ['emptying the hook', sh('echo exit 0 > .git/hooks/pre-push')],
  ['PowerShell removing the hook', ps('Remove-Item .git\\hooks\\pre-push')],
  ['PowerShell overwriting the hook', ps("Set-Content .git/hooks/pre-push 'exit 0'")],
  ['wrapped in bash -c', sh('bash -c "git push --no-verify origin *:*"')],
];

describe('the main cannot get around the pre-push hook', () => {
  it.each(MAIN_DENY)('denies: %s', (_l, call) => {
    expect(main(call).decision).toBe('deny');
  });
  it('the Write and Edit tools may not touch the hook or the release token either', () => {
    expect(main({ tool: 'Write', input: { file_path: join(R, '.git', 'hooks', 'pre-push') } }).decision).toBe('deny');
    expect(main({ tool: 'Edit', input: { file_path: '.git/hooks/pre-push' } }).decision).toBe('deny');
    expect(main({ tool: 'Write', input: { file_path: join(R, '.git', 'console-hooks', 'release-token') } }).decision).toBe('deny');
  });
  it('ordinary work of the main is still allowed', () => {
    for (const c of ['git status', 'git commit -m x', 'git checkout project/x', 'git push origin project/x', 'git push origin HEAD:project/x', 'git config user.name x', 'git merge x', 'git log --oneline']) {
      expect(main(sh(c)), c).toEqual({ decision: 'allow' });
    }
    expect(main({ tool: 'Write', input: { file_path: join(R, 'notes.md') } })).toEqual({ decision: 'allow' });
    expect(main({ tool: 'Write', input: { file_path: join(R, '.git', 'info', 'exclude') } })).toEqual({ decision: 'allow' });
  });
  it('a wildcard refspec and send-pack are refused for agents too', () => {
    expect(evaluate({ role: 'agent', ...sh('git push origin "*:*"') }, ctx).decision).toBe('deny');
    expect(evaluate({ role: 'agent', ...sh('git send-pack origin main') }, ctx).decision).toBe('deny');
  });
});

const RO_DENY: [string, Call][] = [
  ['find -delete', sh('find . -name "*.tmp" -delete')],
  ['find -fprint', sh('find . -fprint out.txt')],
  ['awk in place', sh("awk -i inplace '{print}' f")],
  ['perl in place', sh('perl -pi -e s/a/b/ f')],
  ['npm install', sh('npm install')],
  ['npm ci', sh('npm ci')],
  ['npx prettier --write', sh('npx prettier --write src')],
  ['yarn add', sh('yarn add left-pad')],
  ['pip install', sh('pip install requests')],
  ['unzip', sh('unzip a.zip')],
  ['tar extract', sh('tar -xf a.tar')],
  ['git reflog expire', sh('git reflog expire --all')],
  ['git diff --output', sh('git diff --output=../../x.txt')],
  ['git -c pager', sh('git -c core.pager="sh -c x" log')],
  ['git stash drop', sh('git stash drop')],
  ['PowerShell Export-Csv', ps('Get-Process | Export-Csv p.csv')],
  ['PowerShell WriteAllText', ps("[IO.File]::WriteAllText('a.txt','x')")],
  ['PowerShell Export-Clixml', ps('$x | Export-Clixml a.xml')],
];
const RO_ALLOW: [string, string][] = [
  ['grep with an arrow in the pattern', 'grep -rn "a>b" src'],
  ['grep for a greater-than sign', 'grep -n ">" f'],
  ['rg with a fat arrow', 'rg "=>\\s*\\{" src'],
  ['rg for an html tag', 'rg "<div>x" src'],
  ['git log with a > in the format', 'git log --format="%h>%s"'],
  ['git stash list', 'git stash list'],
  ['git stash show', 'git stash show -p'],
  ['git diff', 'git diff project/p...HEAD'],
  ['git log -p', 'git log -p -n 3'],
  ['find without actions', 'find . -name "*.ts"'],
  ['npm test', 'npm test'],
  ['npm run test', 'npm run test'],
  ['npm ls', 'npm ls'],
  ['tar listing', 'tar -tf a.tar'],
];

describe('read-only sessions: what they could still change, and what they wrongly could not read', () => {
  it.each(RO_DENY)('denies: %s', (_l, call) => {
    expect(reviewer(call).decision).toBe('deny');
  });
  it.each(RO_ALLOW)('allows: %s', (_l, command) => {
    expect(reviewer(sh(command)), command).toEqual({ decision: 'allow' });
  });
  it('still refuses a real redirect next to a search', () => {
    expect(reviewer(sh('grep -rn foo src > out.txt')).decision).toBe('deny');
    expect(reviewer(sh('rg foo >out.txt')).decision).toBe('deny');
    expect(reviewer(sh('git log >> history.txt')).decision).toBe('deny');
  });
});
