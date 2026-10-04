// Real temporary git repositories for the Phase 3 tests (the repository path contains a space on purpose).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const gitSync = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

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
