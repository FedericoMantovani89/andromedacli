import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { branchesOf, gitSync, makeRepo, type TestRepo, removeDir } from './git-helpers';
import { git } from '../src/server/git/git';
import { installReleaseHook, withReleaseToken } from '../src/server/git/release-hook';

const repos: TestRepo[] = [];
const repo = (): TestRepo => { const t = makeRepo({ remote: true }); repos.push(t); return t; };
afterEach(() => { while (repos.length) removeDir(repos.pop()!.base); });

const commit = (cwd: string, name = `f-${Math.random().toString(36).slice(2)}.txt`): void => {
  writeFileSync(join(cwd, name), 'x');
  gitSync(cwd, 'add', '-A');
  gitSync(cwd, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', 'c');
};
const push = (cwd: string, ...args: string[]) => git(cwd, ['push', ...args], { timeoutMs: 60_000 });

describe('main repository pre-push hook', () => {
  it('is installed in a repository without hooks', async () => {
    const t = repo();
    expect(await installReleaseHook(t.repo)).toBe('installed');
    const file = join(t.repo, '.git', 'hooks', 'pre-push');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('console-release-hook');
    expect(await installReleaseHook(t.repo)).toBe('installed'); // again: still ours, rewritten, no error
  });
  it('refuses protected branches and tags, allows the rest', async () => {
    const t = repo();
    await installReleaseHook(t.repo);
    commit(t.repo);
    expect((await push(t.repo, 'origin', 'main')).code).not.toBe(0);
    expect((await push(t.repo, 'origin', 'HEAD:main')).code).not.toBe(0);
    expect((await push(t.repo, '--force', 'origin', 'main')).code).not.toBe(0);
    expect((await push(t.repo, 'origin', 'HEAD:refs/heads/master')).code).not.toBe(0);
    expect((await push(t.repo, 'origin', 'HEAD:refs/heads/develop')).code).not.toBe(0);
    expect((await push(t.repo, 'origin', 'HEAD:refs/heads/release/1.0')).code).not.toBe(0);
    gitSync(t.repo, 'tag', 'v1');
    expect((await push(t.repo, 'origin', 'v1')).code).not.toBe(0);
    expect((await push(t.repo, 'origin', '--delete', 'main')).code).not.toBe(0);
    expect((await push(t.repo, 'origin', 'HEAD:refs/heads/feature-x')).code).toBe(0);
    expect(branchesOf(t.remote).sort()).toEqual(['feature-x', 'main']);
    expect(gitSync(t.remote, 'rev-parse', 'main')).not.toBe(gitSync(t.repo, 'rev-parse', 'HEAD')); // main did not move
  });
  it('lets the console push when it holds the one-time token, and removes the token afterwards', async () => {
    const t = repo();
    await installReleaseHook(t.repo);
    commit(t.repo);
    const tokenFile = join(t.repo, '.git', 'console-hooks', 'release-token');
    const result = await withReleaseToken(t.repo, async (env) => {
      expect(existsSync(tokenFile)).toBe(true);
      return push(t.repo, 'origin', 'main', ...[]).then(async () => git(t.repo, ['push', 'origin', 'main'], { env }));
    });
    expect(result.code).toBe(0);
    expect(existsSync(tokenFile)).toBe(false);
    expect(gitSync(t.remote, 'rev-parse', 'main')).toBe(gitSync(t.repo, 'rev-parse', 'HEAD'));
    commit(t.repo);
    expect((await push(t.repo, 'origin', 'main')).code).not.toBe(0); // the token is gone: back to refused
  });
  it('a wrong token, a missing token file, or a token without the variable is refused', async () => {
    const t = repo();
    await installReleaseHook(t.repo);
    commit(t.repo);
    await withReleaseToken(t.repo, async () => {
      expect((await git(t.repo, ['push', 'origin', 'main'], { env: { CONSOLE_RELEASE_TOKEN: 'guess' } })).code).not.toBe(0);
      expect((await push(t.repo, 'origin', 'main')).code).not.toBe(0); // the file exists but the caller does not know the token
    });
    expect((await git(t.repo, ['push', 'origin', 'main'], { env: { CONSOLE_RELEASE_TOKEN: '' } })).code).not.toBe(0);
    expect((await git(t.repo, ['push', 'origin', 'main'], { env: { CONSOLE_RELEASE_TOKEN: 'anything' } })).code).not.toBe(0);
  });
  it('the token is removed even when the push fails or the callback throws', async () => {
    const t = repo();
    await installReleaseHook(t.repo);
    const tokenFile = join(t.repo, '.git', 'console-hooks', 'release-token');
    await expect(withReleaseToken(t.repo, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(existsSync(tokenFile)).toBe(false);
  });
  it('does not replace a hook the project already has, nor work when core.hooksPath is set', async () => {
    const own = repo();
    mkdirSync(join(own.repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(own.repo, '.git', 'hooks', 'pre-push'), '#!/bin/sh\necho mine\nexit 0\n');
    expect(await installReleaseHook(own.repo)).toBe('skipped_existing');
    expect(readFileSync(join(own.repo, '.git', 'hooks', 'pre-push'), 'utf8')).toContain('echo mine');
    const hp = repo();
    gitSync(hp.repo, 'config', 'core.hooksPath', '.husky');
    expect(await installReleaseHook(hp.repo)).toBe('skipped_hookspath');
    expect(existsSync(join(hp.repo, '.git', 'hooks', 'pre-push'))).toBe(false);
  });
  it('a worktree of the repository without its own hooksPath uses the same hook', async () => {
    const t = repo();
    await installReleaseHook(t.repo);
    const wt = join(t.base, 'extra');
    gitSync(t.repo, 'worktree', 'add', '-q', '-b', 'side', wt);
    commit(wt);
    expect((await push(wt, 'origin', 'HEAD:main')).code).not.toBe(0);
    expect((await push(wt, 'origin', 'side')).code).toBe(0);
  });
});
