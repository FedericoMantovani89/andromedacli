import { it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentWorktree, worktreesDirFor } from '../src/server/git/worktree';
import { ensureProjectWorktree } from '../src/server/git/merge';
import { purgeProject } from '../src/server/git/purge';
import { makeRepo, gitSync } from './git-helpers';

vi.setConfig({ testTimeout: 60_000 });

it('worktrees go under the project .andromedacli and a purge takes the project back to never opened', async () => {
  const { repo } = makeRepo();
  const dir = worktreesDirFor(repo, repo);
  expect(dir).toBe(join(repo, '.andromedacli', 'worktrees'));
  const a = await createAgentWorktree({ repo, project: 'shop-api', slug: 'a-job', dir });
  expect(a.path).toBe(join(dir, 'a-job'));
  expect((await ensureProjectWorktree(repo, 'shop-api', dir))).toMatchObject({ ok: true, path: join(dir, '.project') });
  // The checkout of the user is not dirtied by what lives under .andromedacli.
  expect(gitSync(repo, 'status', '--porcelain')).toBe('');
  mkdirSync(join(repo, '.andromedacli', 'state'), { recursive: true });
  writeFileSync(join(repo, '.andromedacli', 'state', 'agents.json'), '[]');

  await purgeProject({ projectRoot: repo, project: 'shop-api', slugs: ['a-job'], worktrees: [a.path] });

  expect(existsSync(join(repo, '.andromedacli'))).toBe(false);
  expect(gitSync(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1);
  const branches = gitSync(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean);
  expect(branches.some((b) => b.startsWith('agent/shop-api/') || b === 'project/shop-api')).toBe(false);
  expect(existsSync(join(repo, 'README.md'))).toBe(true);
});

it('a project folder with several repos keeps one folder per repo under the project .andromedacli', () => {
  expect(worktreesDirFor('D:/p/abc-website', 'D:/p/abc-website/abc-fe')).toBe(join('D:/p/abc-website', '.andromedacli', 'worktrees', 'abc-fe'));
});
