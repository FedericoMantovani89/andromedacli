import { it, expect } from 'vitest';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { ensurePlanBranch, createAgentWorktree, removeWorktree, GitError } from '../src/server/git/worktree';
import { git } from '../src/server/git/git';
import { makeRepo, gitSync } from './git-helpers';

it('creates the plan branch from HEAD once, and is idempotent', async () => {
  const { repo } = makeRepo();
  const first = await ensurePlanBranch(repo, 'shop-api');
  expect(first).toEqual({ branch: 'plan/shop-api', created: true });
  expect(gitSync(repo, 'rev-parse', 'plan/shop-api')).toBe(gitSync(repo, 'rev-parse', 'HEAD'));
  expect(await ensurePlanBranch(repo, 'shop-api')).toEqual({ branch: 'plan/shop-api', created: false });
});
it('refuses a repository without any commit', async () => {
  const { repo } = makeRepo({ commit: false });
  await expect(ensurePlanBranch(repo, 'shop-api')).rejects.toMatchObject({ code: 'git.noCommits' });
});
it('creates agent/<plan>/<slug> from the plan branch in a sibling folder, even when the repo path has a space', async () => {
  const { repo } = makeRepo();
  const wt = await createAgentWorktree({ repo, plan: 'shop-api', slug: 'fix-login' });
  expect(wt.branch).toBe('agent/shop-api/fix-login');
  expect(wt.path).toBe(join(dirname(repo), `${basename(repo)}.worktrees`, 'fix-login'));
  expect(existsSync(join(wt.path, 'README.md'))).toBe(true);
  expect(gitSync(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('agent/shop-api/fix-login');
  expect(gitSync(wt.path, 'rev-parse', 'HEAD')).toBe(gitSync(repo, 'rev-parse', 'plan/shop-api'));
});
it('ignores the .console folder through the repo exclude file, once', async () => {
  const { repo } = makeRepo();
  await createAgentWorktree({ repo, plan: 'p-one', slug: 'a-job' });
  await createAgentWorktree({ repo, plan: 'p-one', slug: 'b-job' });
  const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
  expect(exclude.split('\n').filter((l) => l.trim() === '.console/')).toHaveLength(1);
  const wt = join(dirname(repo), `${basename(repo)}.worktrees`, 'a-job');
  mkdirSync(join(wt, '.console'));
  writeFileSync(join(wt, '.console', 'checklist.md'), 'x');
  expect(gitSync(wt, 'status', '--porcelain')).toBe('');
});
it('refuses an existing folder or branch and leaves nothing behind', async () => {
  const { repo } = makeRepo();
  const folder = join(dirname(repo), `${basename(repo)}.worktrees`, 'taken-job');
  mkdirSync(folder, { recursive: true });
  await expect(createAgentWorktree({ repo, plan: 'p-one', slug: 'taken-job' })).rejects.toMatchObject({ code: 'git.worktreeExists' });
  expect(gitSync(repo, 'branch', '--list', 'agent/p-one/taken-job')).toBe('');
  await createAgentWorktree({ repo, plan: 'p-one', slug: 'other-job' });
  await removeWorktree(repo, join(dirname(repo), `${basename(repo)}.worktrees`, 'other-job'));
  // the branch of the removed worktree still exists (the work is the branch), so the same name is refused
  await expect(createAgentWorktree({ repo, plan: 'p-one', slug: 'other-job' })).rejects.toBeInstanceOf(GitError);
});
it('removeWorktree takes the folder away and keeps the branch', async () => {
  const { repo } = makeRepo();
  const wt = await createAgentWorktree({ repo, plan: 'p-one', slug: 'gone-job' });
  await removeWorktree(repo, wt.path);
  expect(existsSync(wt.path)).toBe(false);
  expect(gitSync(repo, 'branch', '--list', 'agent/p-one/gone-job')).toContain('agent/p-one/gone-job');
});
it('git() never throws and reports the exit code', async () => {
  const { repo } = makeRepo();
  const r = await git(repo, ['rev-parse', '--verify', 'refs/heads/nope']);
  expect(r.code).not.toBe(0);
  const ok = await git(repo, ['rev-parse', 'HEAD']);
  expect(ok.code).toBe(0);
  expect(ok.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
});

import { agentBranchFor, worktreePathFor, discardAgentWorktree, checkSpawnable } from '../src/server/git/worktree';
import { installPushHook } from '../src/server/git/hooks';

it('names the worktree and the branch in one place', () => {
  expect(agentBranchFor('shop-api', 'fix-login')).toBe('agent/shop-api/fix-login');
  const repo = join('D:', 'w', 'my repo');
  expect(worktreePathFor(repo, 'fix-login')).toBe(join(dirname(repo), 'my repo.worktrees', 'fix-login'));
});
it('checkSpawnable reports notRepo, noCommits and worktreeExists without creating anything', async () => {
  const empty = makeRepo({ commit: false });
  expect(await checkSpawnable({ repo: empty.repo, plan: 'p-one', slug: 'a-job' })).toBe('git.noCommits');
  const plain = join(empty.base, 'plain');
  mkdirSync(plain);
  expect(await checkSpawnable({ repo: plain, plan: 'p-one', slug: 'a-job' })).toBe('git.notRepo');
  const { repo } = makeRepo();
  expect(await checkSpawnable({ repo, plan: 'p-one', slug: 'a-job' })).toBeUndefined();
  expect(gitSync(repo, 'branch', '--list', 'plan/*')).toBe(''); // nothing was created
  await createAgentWorktree({ repo, plan: 'p-one', slug: 'a-job' });
  expect(await checkSpawnable({ repo, plan: 'p-one', slug: 'a-job' })).toBe('git.worktreeExists');
});
it('checkSpawnable sees a leftover branch and a leftover folder separately', async () => {
  const { repo } = makeRepo();
  gitSync(repo, 'branch', 'agent/p-one/only-branch');
  expect(await checkSpawnable({ repo, plan: 'p-one', slug: 'only-branch' })).toBe('git.worktreeExists');
  mkdirSync(worktreePathFor(repo, 'only-folder'), { recursive: true });
  expect(await checkSpawnable({ repo, plan: 'p-one', slug: 'only-folder' })).toBe('git.worktreeExists');
});
it('discardAgentWorktree removes folder, branch and hook folder, and is safe to repeat', async () => {
  const { repo } = makeRepo();
  const wt = await createAgentWorktree({ repo, plan: 'p-one', slug: 'a-job' });
  await installPushHook({ repo, worktree: wt.path, branch: wt.branch, slug: 'a-job' });
  const hooks = join(repo, '.git', 'console-hooks', 'a-job');
  expect(existsSync(hooks)).toBe(true);
  await discardAgentWorktree({ repo, slug: 'a-job', branch: wt.branch, path: wt.path });
  expect(existsSync(wt.path)).toBe(false);
  expect(existsSync(hooks)).toBe(false);
  expect(gitSync(repo, 'branch', '--list', 'agent/*')).toBe('');
  await discardAgentWorktree({ repo, slug: 'a-job', branch: wt.branch, path: wt.path });
});

it('four agents started at the same moment on a fresh repository all get their worktree and hook (review finding: plan branch race)', async () => {
  const { repo } = makeRepo();
  const slugs = ['first-job', 'second-job', 'third-job', 'fourth-job'];
  const made = await Promise.all(slugs.map(async (slug) => {
    const wt = await createAgentWorktree({ repo, plan: 'p-one', slug });
    await installPushHook({ repo, worktree: wt.path, branch: wt.branch, slug });
    return wt;
  }));
  expect(made.map((m) => m.branch).sort()).toEqual(slugs.map((s) => `agent/p-one/${s}`).sort());
  for (const m of made) expect(gitSync(m.path, 'config', '--worktree', '--get', 'core.hooksPath')).toContain('console-hooks');
  expect(gitSync(repo, 'branch', '--list', 'plan/*').trim()).toBe('plan/p-one');
});
it('ensurePlanBranch called twice at once creates the branch once and reports success both times', async () => {
  const { repo } = makeRepo();
  const [a, b] = await Promise.all([ensurePlanBranch(repo, 'p-one'), ensurePlanBranch(repo, 'p-one')]);
  expect([a.branch, b.branch]).toEqual(['plan/p-one', 'plan/p-one']);
  expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
});
