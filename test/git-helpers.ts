// Real temporary git repositories for the Phase 3 tests (the repository path contains a space on purpose).
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Runs git and returns its trimmed output; throws on failure. A failure is tried again twice after a short pause: on a loaded
 * Windows machine git sometimes fails to start or to take a lock for no reason of its own (the same reason `git()` retries).
 */
export const gitSync = (cwd: string, ...args: string[]): string => {
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (e) {
      if (attempt >= 3) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150 * attempt);
    }
  }
};

export interface TestRepo { base: string; repo: string; remote: string }

interface RepoOptions { remote?: boolean; commit?: boolean; identity?: boolean }

/** Builds the repo (and its bare origin) inside `base` with real git calls: about a second, so it is done once per option set and copied. */
function buildRepo(base: string, o: RepoOptions): { repo: string; remote: string } {
  const repo = join(base, 'my repo');
  const remote = join(base, 'remote.git');
  mkdirSync(repo);
  gitSync(repo, 'init', '-q', '-b', 'main');
  gitSync(repo, 'config', 'core.autocrlf', 'false');
  if (o.identity !== false) { gitSync(repo, 'config', 'user.name', 'Tester'); gitSync(repo, 'config', 'user.email', 't@example.com'); }
  if (o.commit !== false) {
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    gitSync(repo, 'add', '-A');
    gitSync(repo, '-c', 'user.name=Tester', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
  }
  if (o.remote) {
    mkdirSync(remote);
    gitSync(remote, 'init', '-q', '--bare');
    gitSync(repo, 'remote', 'add', 'origin', remote);
    if (o.commit !== false) gitSync(repo, 'push', '-q', 'origin', 'main');
  }
  return { repo, remote };
}

/** One built repo per option set in this process (each test file runs in its own), removed when the process ends. */
const templates = new Map<string, string>();

function templateFor(o: RepoOptions): string {
  const key = `${o.remote ? 'r' : '-'}${o.commit === false ? '-' : 'c'}${o.identity === false ? '-' : 'i'}`;
  let dir = templates.get(key);
  if (dir === undefined) {
    dir = mkdtempSync(join(tmpdir(), 'gitt-template-'));
    buildRepo(dir, o);
    templates.set(key, dir);
    if (templates.size === 1) process.on('exit', () => { for (const d of templates.values()) { try { rmSync(d, { recursive: true, force: true }); } catch { /* the temp cleaner gets it later */ } } });
  }
  return dir;
}

/**
 * A repo with one commit on `main`, a bare `origin`, and a configured identity. It is a copy of a repo built once per option set
 * (about 0.2 s instead of 1 s of git calls, much more under load); only `origin` has to point at the copy's own bare repo.
 */
export function makeRepo(o: RepoOptions = {}): TestRepo {
  const base = mkdtempSync(join(tmpdir(), 'gitt-'));
  cpSync(templateFor(o), base, { recursive: true });
  const repo = join(base, 'my repo');
  const remote = join(base, 'remote.git');
  if (o.remote) gitSync(repo, 'remote', 'set-url', 'origin', remote);
  return { base, repo, remote };
}

export const branchesOf = (remote: string): string[] =>
  gitSync(remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/tags').split('\n').filter(Boolean);

/**
 * Removes a temporary repository. A folder that Windows still holds for a moment (an antivirus scan, an indexer, a git process that
 * is just closing) is retried for a while and, if it still cannot go, left behind: cleaning up a scratch folder must never fail a test.
 */
export function removeDir(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 30, retryDelay: 300 });
  } catch { /* the operating system's temp cleaner gets it later */ }
}

export interface MultiRepo { base: string; root: string; repos: Record<string, { repo: string; remote: string }> }

/** A project folder that is NOT a repository, holding one repo (one commit on `main`, optionally a bare origin) per name. */
export function makeMultiRepo(names: string[], o: { remote?: boolean } = {}): MultiRepo {
  const base = mkdtempSync(join(tmpdir(), 'multi-'));
  const root = join(base, 'abc website');
  mkdirSync(root);
  const repos: MultiRepo['repos'] = {};
  for (const name of names) {
    const repo = join(root, name);
    const remote = join(base, `${name}-remote.git`);
    mkdirSync(repo);
    gitSync(repo, 'init', '-q', '-b', 'main');
    gitSync(repo, 'config', 'core.autocrlf', 'false');
    gitSync(repo, 'config', 'user.name', 'Tester');
    gitSync(repo, 'config', 'user.email', 't@example.com');
    writeFileSync(join(repo, 'README.md'), `${name}\n`);
    gitSync(repo, 'add', '-A');
    gitSync(repo, 'commit', '-q', '-m', 'init');
    if (o.remote) {
      mkdirSync(remote);
      gitSync(remote, 'init', '-q', '--bare');
      gitSync(repo, 'remote', 'add', 'origin', remote);
      gitSync(repo, 'push', '-q', 'origin', 'main');
    }
    repos[name] = { repo, remote };
  }
  return { base, root, repos };
}

/** Where the server puts an agent's worktree when the project folder is the repository: `<repo>/.andromedaconsole/worktrees/<slug>`. */
export const worktreePathFor = (repo: string, slug: string): string => join(repo, '.andromedaconsole', 'worktrees', slug);
