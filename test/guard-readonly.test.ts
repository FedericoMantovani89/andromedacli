import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluate, type GuardContext } from '../src/server/guard/rules';
import { DEFAULT_SECRET_PATTERNS } from '../src/server/git/secrets';

let root: string;
let W: string;
let ctx: GuardContext;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'guardro-'));
  W = join(root, 'repo.worktrees', 'review-a-job');
  mkdirSync(W, { recursive: true });
  ctx = { worktree: W, repo: join(root, 'repo'), branch: 'review/review-a-job', projectBranch: 'project/p', secretPatterns: DEFAULT_SECRET_PATTERNS, readOnly: true };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Call = { tool: string; input: Record<string, unknown> };
const sh = (command: string): Call => ({ tool: 'Bash', input: { command } });
const ps = (command: string): Call => ({ tool: 'PowerShell', input: { command } });
const reviewer = (c: Call) => evaluate({ role: 'agent', ...c }, ctx);
const writer = (c: Call) => evaluate({ role: 'agent', ...c }, { ...ctx, readOnly: false });

const DENY: [string, Call][] = [
  ['Write inside the worktree', { tool: 'Write', input: { file_path: 'notes.md' } }],
  ['Write absolute inside', { tool: 'Write', input: { file_path: 'src/deep/a.ts' } }],
  ['Edit', { tool: 'Edit', input: { file_path: 'src/a.ts' } }],
  ['NotebookEdit', { tool: 'NotebookEdit', input: { notebook_path: 'n.ipynb' } }],
  ['redirect >', sh('echo x > file.txt')],
  ['redirect >>', sh('echo x >> file.txt')],
  ['redirect glued', sh('echo x>file.txt')],
  ['redirect 1>', sh('ls 1> out.txt')],
  ['cat into a file', sh('cat a > b')],
  ['tee', sh('ls | tee out.txt')],
  ['rm', sh('rm file.txt')],
  ['rm -rf inside', sh('rm -rf build')],
  ['cp', sh('cp a b')],
  ['mv', sh('mv a b')],
  ['mkdir', sh('mkdir x')],
  ['touch', sh('touch x')],
  ['sed -i', sh('sed -i s/a/b/ f.txt')],
  ['sed --in-place', sh('sed --in-place s/a/b/ f.txt')],
  ['install', sh('install -m 755 a b')],
  ['chmod', sh('chmod +x run.sh')],
  ['wget', sh('wget http://x/f.zip')],
  ['curl -o', sh('curl -o out.json http://x')],
  ['curl -O', sh('curl -O http://x/f.zip')],
  ['git add', sh('git add .')],
  ['git rm', sh('git rm f')],
  ['git mv', sh('git mv a b')],
  ['git stash', sh('git stash')],
  ['git checkout -- file', sh('git checkout -- f')],
  ['git restore', sh('git restore f')],
  ['git clean', sh('git clean -fd')],
  ['git apply', sh('git apply p.diff')],
  ['git reset', sh('git reset')],
  ['git fetch', sh('git fetch')],
  ['git commit', sh('git commit -m x')],
  ['git branch create', sh('git branch newb')],
  ['git tag create', sh('git tag v1')],
  ['git worktree add', sh('git worktree add ../x')],
  ['git config set', sh('git config user.name x')],
  ['git revert', sh('git revert HEAD')],
  ['git -C . add', sh('git -C . add .')],
  ['wrapped: bash -c', sh('bash -c "echo x > f"')],
  ['wrapped: if/then', sh('if true; then rm f; fi')],
  ['wrapped: subshell', sh('(touch x)')],
  ['PS Set-Content', ps('Set-Content f x')],
  ['PS Out-File', ps("'x' | Out-File f")],
  ['PS Add-Content', ps('Add-Content f x')],
  ['PS New-Item', ps('New-Item f')],
  ['PS ni', ps('ni f')],
  ['PS Remove-Item', ps('Remove-Item f')],
  ['PS Copy-Item', ps('Copy-Item a b')],
  ['PS Move-Item', ps('Move-Item a b')],
  ['PS Clear-Content', ps('Clear-Content f')],
  ['PS redirect', ps("'x' > f.txt")],
  ['PS sc', ps('sc f x')],
  ['PS iwr -OutFile', ps('iwr http://x -OutFile f.zip')],
  ['PS foreach block', ps('foreach ($f in 1,2) { Set-Content a$f x }')],
  ['PS del', ps('del f')],
  ['PS mkdir', ps('mkdir x')],
];
const ALLOW: [string, Call][] = [
  ['Read', { tool: 'Read', input: { file_path: 'src/a.ts' } }],
  ['Grep', { tool: 'Grep', input: { pattern: 'x', path: 'src' } }],
  ['Glob', { tool: 'Glob', input: { pattern: '**/*.ts' } }],
  ['git diff against the project branch', sh('git diff project/p...HEAD')],
  ['git diff --stat', sh('git diff --stat project/p...HEAD')],
  ['git log', sh('git log --oneline -n 5')],
  ['git show', sh('git show HEAD')],
  ['git status', sh('git status')],
  ['git blame', sh('git blame src/a.ts')],
  ['git ls-files', sh('git ls-files')],
  ['git grep', sh('git grep TODO')],
  ['git rev-parse', sh('git rev-parse HEAD')],
  ['git cat-file', sh('git cat-file -p HEAD')],
  ['git merge-base', sh('git merge-base project/p HEAD')],
  ['git branch --list', sh('git branch --list')],
  ['git tag -l', sh('git tag -l')],
  ['git config --get', sh('git config --get user.name')],
  ['git worktree list', sh('git worktree list')],
  ['git remote -v', sh('git remote -v')],
  ['git -C . log', sh('git -C . log')],
  ['cat', sh('cat src/a.ts')],
  ['type', ps('type src\\a.ts')],
  ['ls', sh('ls -la')],
  ['dir', sh('dir')],
  ['grep -r', sh('grep -rn TODO src')],
  ['rg', sh('rg foo')],
  ['head', sh('head -n 20 src/a.ts')],
  ['wc', sh('wc -l src/a.ts')],
  ['find', sh('find . -name "*.ts"')],
  ['sed -n', sh('sed -n 1,5p src/a.ts')],
  ['awk', sh("awk '{print $1}' src/a.ts")],
  ['diff', sh('diff a b')],
  ['echo', sh('echo hello')],
  ['echo to /dev/null', sh('echo hi > /dev/null')],
  ['stderr to /dev/null', sh('ls 2>/dev/null')],
  ['stderr to stdout', sh('npm test 2>&1 | tail')],
  ['to nul', sh('ls > nul')],
  ['PS to $null', ps('Get-ChildItem > $null')],
  ['PS 2>$null', ps('Get-ChildItem 2>$null')],
  ['quoted arrow in text', sh('echo "a > b"')],
  ['npm test', sh('npm test')],
  ['node --test', sh('node --test')],
  ['curl to stdout', sh('curl http://localhost:3000/x')],
  ['pwd', sh('pwd')],
  ['cd then ls', sh('cd src && ls')],
  ['PS Get-Content', ps('Get-Content src\\a.ts')],
  ['PS Get-ChildItem', ps('Get-ChildItem -Recurse')],
  ['PS Select-String', ps('Select-String foo src\\a.ts')],
  ['PS Write-Host', ps('Write-Host hi')],
  ['PS pipeline', ps('Get-ChildItem | Where-Object { $_.Length -gt 10 } | Select-Object Name')],
  ['empty command', sh('')],
];

describe('read-only sessions (a reviewer)', () => {
  it.each(DENY)('denies: %s', (_l, call) => {
    expect(reviewer(call).decision).toBe('deny');
  });
  it.each(ALLOW)('allows: %s', (_l, call) => {
    expect(reviewer(call)).toEqual({ decision: 'allow' });
  });
  it('the same calls are not refused by the read-only rule for a normal agent', () => {
    for (const call of [sh('echo x > file.txt'), sh('touch x'), { tool: 'Write', input: { file_path: 'a.ts' } } as Call, sh('git add .'), ps('Set-Content f x')]) {
      expect(writer(call), JSON.stringify(call)).toEqual({ decision: 'allow' });
    }
  });
  it('names the rule so the log and the reviewer know why', () => {
    const d = reviewer(sh('touch x'));
    expect(d).toMatchObject({ decision: 'deny', rule: 'readonly.write' });
    expect(d.decision === 'deny' && d.reason).toMatch(/read-only/i);
    expect(reviewer({ tool: 'Write', input: { file_path: 'a.ts' } })).toMatchObject({ rule: 'readonly.write' });
  });
  it('the other agent rules still apply on top', () => {
    expect(reviewer(sh('git push --force'))).toMatchObject({ decision: 'deny', rule: 'git.force' });
    expect(reviewer(sh('cat .env'))).toMatchObject({ decision: 'deny', rule: 'secret.file' });
  });
  it('the main is never read-only', () => {
    expect(evaluate({ role: 'main', ...sh('touch x') }, ctx)).toEqual({ decision: 'allow' });
  });
});

describe('git remote in a read-only session', () => {
  it('listing is fine, changing is not', () => {
    for (const c of ['git remote', 'git remote -v', 'git remote show origin', 'git remote get-url origin']) expect(reviewer(sh(c)), c).toEqual({ decision: 'allow' });
    for (const c of ['git remote add x http://y', 'git remote remove origin', 'git remote set-url origin http://y', 'git remote rename a b']) expect(reviewer(sh(c)).decision, c).toBe('deny');
  });
});
