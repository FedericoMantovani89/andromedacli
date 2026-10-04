import { it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentWorktree } from '../src/server/git/worktree';
import { installPushHook } from '../src/server/git/hooks';
import { git } from '../src/server/git/git';
import { makeRepo, gitSync, branchesOf } from './git-helpers';

async function setup() {
  const t = makeRepo({ remote: true });
  const wt = await createAgentWorktree({ repo: t.repo, plan: 'shop-api', slug: 'fix-login' });
  await installPushHook({ repo: t.repo, worktree: wt.path, branch: wt.branch, slug: 'fix-login' });
  const commit = (msg: string) => {
    writeFileSync(join(wt.path, `f-${Math.random().toString(36).slice(2)}.txt`), msg);
    gitSync(wt.path, 'add', '-A');
    gitSync(wt.path, '-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '-q', '-m', msg);
  };
  return { ...t, wt, commit };
}

it('allows the push of the agent\'s own branch', async () => {
  const { wt, remote, commit } = await setup();
  commit('one');
  const r = await git(wt.path, ['push', 'origin', 'HEAD']);
  expect(r.code, r.stderr).toBe(0);
  expect(branchesOf(remote)).toContain('agent/shop-api/fix-login');
});
it('refuses any other ref (another branch name, main)', async () => {
  const { wt, remote, commit } = await setup();
  commit('one');
  for (const ref of ['HEAD:refs/heads/other', 'HEAD:refs/heads/main', 'HEAD:refs/heads/plan/shop-api']) {
    const r = await git(wt.path, ['push', 'origin', ref]);
    expect(r.code, ref).not.toBe(0);
    expect(r.stderr).toMatch(/refusing/);
  }
  expect(branchesOf(remote)).toEqual(['main']);
});
it('refuses --force and --force-with-lease after history was rewritten', async () => {
  const { wt, remote, commit } = await setup();
  commit('one');
  expect((await git(wt.path, ['push', 'origin', 'HEAD'])).code).toBe(0);
  gitSync(wt.path, '-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '--amend', '-q', '-m', 'rewritten');
  for (const flag of ['--force', '--force-with-lease']) {
    const r = await git(wt.path, ['push', flag, 'origin', 'HEAD']);
    expect(r.code, flag).not.toBe(0);
  }
  expect(gitSync(remote, 'log', '-1', '--format=%s', 'agent/shop-api/fix-login')).toBe('one');
});
it('refuses deleting a remote branch and pushing tags', async () => {
  const { wt, remote, commit } = await setup();
  commit('one');
  await git(wt.path, ['push', 'origin', 'HEAD']);
  expect((await git(wt.path, ['push', 'origin', ':agent/shop-api/fix-login'])).code).not.toBe(0);
  gitSync(wt.path, 'tag', 'v1');
  expect((await git(wt.path, ['push', 'origin', 'v1'])).code).not.toBe(0);
  expect(branchesOf(remote)).toEqual(['agent/shop-api/fix-login', 'main']);
});
it('does not touch the main worktree: it can still push anything it wants', async () => {
  const { repo, remote, commit } = await setup();
  commit('one');
  const r = await git(repo, ['push', 'origin', 'HEAD:refs/heads/free']);
  expect(r.code, r.stderr).toBe(0);
  expect(branchesOf(remote)).toContain('free');
});
it('the hook lives outside the worktree and is bound to that worktree only', async () => {
  const { repo, wt } = await setup();
  const other = await createAgentWorktree({ repo, plan: 'shop-api', slug: 'other-job' });
  expect((await git(wt.path, ['config', '--worktree', '--get', 'core.hooksPath'])).stdout.trim()).toContain('console-hooks/fix-login');
  expect((await git(other.path, ['config', '--worktree', '--get', 'core.hooksPath'])).code).not.toBe(0);
});
it('rejects a branch name that could inject shell into the hook script', async () => {
  const t = makeRepo({ remote: true });
  const wt = await createAgentWorktree({ repo: t.repo, plan: 'p-one', slug: 'a-job' });
  await expect(installPushHook({ repo: t.repo, worktree: wt.path, branch: 'x"; rm -rf /; "', slug: 'a-job' })).rejects.toThrow(/branch/);
});
