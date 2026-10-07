// Final-review findings (Phase 3): commands wrapped in shell structure, the main's pushes without a refspec, recursive deletes
// through aliases / pipes / cd, and secret patterns that block ordinary work. Each case failed before the fix.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluate, type GuardContext } from '../src/server/guard/rules';
import { DEFAULT_SECRET_PATTERNS, findSecrets } from '../src/server/git/secrets';

let root: string;
let R: string;
let W: string;
let ctx: GuardContext;
const setHead = (ref: string): void => writeFileSync(join(R, '.git', 'HEAD'), `ref: refs/heads/${ref}\n`);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'guardw-'));
  R = join(root, 'repo');
  W = join(root, 'repo.worktrees', 'a b');
  mkdirSync(join(R, '.git', 'refs', 'tags'), { recursive: true });
  mkdirSync(join(R, '.git', 'refs', 'heads'), { recursive: true });
  mkdirSync(W, { recursive: true });
  setHead('main');
  writeFileSync(join(R, '.git', 'refs', 'tags', 'v1.0'), 'abc\n');
  ctx = { worktree: W, repo: R, branch: 'agent/p/a', projectBranch: 'project/p', secretPatterns: DEFAULT_SECRET_PATTERNS };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Call = { tool: string; input: Record<string, unknown> };
const sh = (command: string): Call => ({ tool: 'Bash', input: { command } });
const ps = (command: string): Call => ({ tool: 'PowerShell', input: { command } });
const rd = (file_path: string): Call => ({ tool: 'Read', input: { file_path } });
const agent = (c: Call) => evaluate({ role: 'agent', ...c }, ctx);
const main = (c: Call) => evaluate({ role: 'main', ...c }, { ...ctx, worktree: R });

const AGENT_DENY: [string, Call, string][] = [
  ['if/then/fi push -f', sh('if true; then git push --force; fi'), 'git.force'],
  ['if/then rm -rf ~', sh('if [ -d x ]; then rm -rf ~; fi'), 'rm.wide'],
  ['subshell rm -rf ~', sh('(rm -rf ~)'), 'rm.wide'],
  ['subshell commit', sh('(git commit -m x)'), 'git.commit-push'],
  ['brace group', sh('{ git push -f; }'), 'git.force'],
  ['negation', sh('! git push --force'), 'git.force'],
  ['while/do', sh('while true; do git push -f; done'), 'git.force'],
  ['for/do rm', sh('for d in a b; do rm -rf ..; done'), 'rm.wide'],
  ['timeout', sh('timeout 5 git push --force'), 'git.force'],
  ['xargs', sh('echo a | xargs git push -f'), 'git.force'],
  ['watch', sh('watch git push -f'), 'git.force'],
  ['time', sh('time git push -f'), 'git.force'],
  ['else branch', sh('if false; then ls; else git push --force; fi'), 'git.force'],
  ['no-verify inside a wrapper', sh('bash -c "if true; then git push --no-verify; fi"'), 'git.no-verify'],
  ['PS foreach', ps('foreach ($d in "a") { Remove-Item -Recurse -Force ~ }'), 'rm.wide'],
  ['PS if', ps('if (Test-Path build) { Remove-Item -Recurse -Force C:\\Users }'), 'rm.wide'],
  ['PS iex string', ps('iex "git push -f"'), 'git.force'],
  ['PS Invoke-Expression string', ps("Invoke-Expression 'git push --force'"), 'git.force'],
  ['PS call operator block', ps('& { git push -f }'), 'git.force'],
  ['PS rmdir -Recurse', ps('rmdir C:\\Users\\x -Recurse -Force'), 'rm.wide'],
  ['PS rd -Recurse ..', ps('rd ..\\.. -Recurse'), 'rm.wide'],
  ['PS del -Recurse', ps('del -Recurse -Force C:\\stuff'), 'rm.wide'],
  ['PS piped Remove-Item', ps('Get-ChildItem C:\\stuff | Remove-Item -Recurse -Force'), 'rm.wide'],
  ['cd .. then rm', sh('cd .. && rm -rf repo'), 'rm.wide'],
  ['PS cd .. then Remove-Item', ps('cd ..; Remove-Item -Recurse -Force repo'), 'rm.wide'],
  ['pushd then rm', sh('pushd ..; rm -rf x'), 'rm.wide'],
  ['cd to unknown variable then rm', sh('cd $NOPE_NOT_SET && rm -rf build'), 'rm.wide'],
];
const AGENT_ALLOW: [string, Call][] = [
  ['if/then ls', sh('if true; then ls; fi')],
  ['cd inside then rm build', sh('cd src && rm -rf build')],
  ['PS cd inside then Remove-Item', ps('cd src; Remove-Item -Recurse -Force build')],
  ['cd .. then ls', sh('cd .. && ls')],
  ['PS foreach harmless', ps('foreach ($f in Get-ChildItem) { Write-Host $f }')],
  ['subshell harmless', sh('(cd src && npm test)')],
  ['timeout npm test', sh('timeout 60 npm test')],
  ['PS rmdir inside', ps('rmdir build -Recurse -Force')],
  ['read credentials source file', rd('src/auth/credentials.ts')],
  ['read Credentials.java', rd('src/Credentials.java')],
];

describe('review finding: wrapped commands must not skip the rules', () => {
  it.each(AGENT_DENY)('agent denied: %s', (_l, call, rule) => {
    const d = agent(call);
    expect(d.decision).toBe('deny');
    if (d.decision === 'deny') expect(d.rule).toBe(rule);
  });
  it.each(AGENT_ALLOW)('agent allowed: %s', (_l, call) => {
    expect(agent(call)).toEqual({ decision: 'allow' });
  });
  it('the main is covered inside wrappers too', () => {
    expect(main(sh('if true; then git push --force; fi'))).toMatchObject({ decision: 'deny', rule: 'git.force' });
    expect(main(sh('(git push origin main)'))).toMatchObject({ decision: 'deny', rule: 'git.protected-ref' });
    expect(main(ps('foreach ($d in "a") { git push --force }'))).toMatchObject({ decision: 'deny', rule: 'git.force' });
  });
});

describe('review finding: the main pushing without a refspec', () => {
  it.each(['git push', 'git push origin', 'git push origin HEAD', 'git push -u origin HEAD', 'git push --all', 'git push --set-upstream origin'])(
    'is refused while the repository is on main: %s', (cmd) => {
      setHead('main');
      expect(main(sh(cmd))).toMatchObject({ decision: 'deny', rule: 'git.protected-ref' });
    });
  it('is refused on master and release branches too', () => {
    for (const b of ['master', 'develop', 'release/1.0']) {
      setHead(b);
      expect(main(sh('git push'))).toMatchObject({ decision: 'deny', rule: 'git.protected-ref' });
    }
    setHead('main');
  });
  it('is allowed while the repository is on the project branch', () => {
    setHead('project/shop');
    expect(main(sh('git push'))).toEqual({ decision: 'allow' });
    expect(main(sh('git push origin HEAD'))).toEqual({ decision: 'allow' });
    expect(main(sh('git push origin project/shop'))).toEqual({ decision: 'allow' });
    setHead('main');
  });
  it('pushing an existing tag by name is a tag push', () => {
    expect(main(sh('git push origin v1.0'))).toMatchObject({ decision: 'deny', rule: 'git.tag' });
    expect(main(sh('git push origin refs/tags/v1.0'))).toMatchObject({ decision: 'deny', rule: 'git.tag' });
  });
  it('a detached or unreadable HEAD does not make every push refused', () => {
    writeFileSync(join(R, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
    expect(main(sh('git push origin project/shop'))).toEqual({ decision: 'allow' });
    setHead('main');
  });
});

describe('review finding: secret patterns must not block ordinary work', () => {
  it('template files and source files named credentials are not secrets', () => {
    const files = ['.env.example', 'config/.env.sample', '.env.template', 'src/credentials.ts', 'src/auth/Credentials.java', 'docs/credentials.md'];
    expect(findSecrets(files, DEFAULT_SECRET_PATTERNS)).toEqual([]);
  });
  it('real secret files still are', () => {
    const files = ['.env', '.env.production', 'config/.env.local', 'credentials.json', 'aws/credentials', 'server.pem', 'id_rsa', 'deploy.key'];
    expect(findSecrets(files, DEFAULT_SECRET_PATTERNS).sort()).toEqual([...files].sort());
  });
});
