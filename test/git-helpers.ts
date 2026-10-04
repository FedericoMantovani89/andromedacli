// Real temporary git repositories for the Phase 3 tests (the repository path contains a space on purpose).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

/** A repo with one commit on `main`, a bare `origin`, and a configured identity. */
export function makeRepo(o: { remote?: boolean; commit?: boolean; identity?: boolean } = {}): TestRepo {
  const base = mkdtempSync(join(tmpdir(), 'gitt-'));
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
