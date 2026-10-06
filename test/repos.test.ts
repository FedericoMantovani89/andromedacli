import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { discoverRepos, repoPathOf, resolveRepo } from '../src/server/git/repos';
import { makeMultiRepo, makeRepo, removeDir } from './git-helpers';

const bases: string[] = [];
afterEach(() => { while (bases.length) removeDir(bases.pop()!); });

it('a plan root that is a repository is the single repo ""', () => {
  const t = makeRepo(); bases.push(t.base);
  expect(discoverRepos(t.repo)).toEqual(['']);
  expect(resolveRepo(t.repo, undefined)).toMatchObject({ ok: true, rel: '' });
  expect(resolveRepo(t.repo, '')).toMatchObject({ ok: true, rel: '' });
});
it('a plan root inside a bigger repository still counts as a repo (as before)', () => {
  const t = makeRepo(); bases.push(t.base);
  const sub = join(t.repo, 'packages', 'x'); mkdirSync(sub, { recursive: true });
  expect(discoverRepos(sub)).toEqual(['']);
});
it('finds the sub-repositories one level down, sorted, skipping hidden and .worktrees folders and plain folders', () => {
  const m = makeMultiRepo(['abc-fe', 'abc-be']); bases.push(m.base);
  mkdirSync(join(m.root, 'docs'));
  mkdirSync(join(m.root, '.hidden', '.git'), { recursive: true });
  mkdirSync(join(m.root, 'abc-fe.worktrees', 'x', '.git'), { recursive: true });
  expect(discoverRepos(m.root)).toEqual(['abc-be', 'abc-fe']);
});
it('with no repository anywhere: git.notRepo', () => {
  const plain = mkdtempSync(join(tmpdir(), 'plain-')); bases.push(plain);
  expect(discoverRepos(plain)).toEqual([]);
  expect(resolveRepo(plain, undefined)).toEqual({ ok: false, code: 'git.notRepo', repos: [] });
  expect(resolveRepo(plain, 'abc-fe')).toEqual({ ok: false, code: 'git.notRepo', repos: [] });
});
it('several repos and no choice: git.repoRequired with the list; a single one is chosen by itself', () => {
  const m = makeMultiRepo(['abc-fe', 'abc-be']); bases.push(m.base);
  expect(resolveRepo(m.root, undefined)).toEqual({ ok: false, code: 'git.repoRequired', repos: ['abc-be', 'abc-fe'] });
  const one = makeMultiRepo(['only']); bases.push(one.base);
  expect(resolveRepo(one.root, undefined)).toMatchObject({ ok: true, rel: 'only', path: join(one.root, 'only') });
});
it('only an exact discovered name is accepted', () => {
  const m = makeMultiRepo(['abc-fe', 'abc-be']); bases.push(m.base);
  expect(resolveRepo(m.root, 'abc-fe')).toMatchObject({ ok: true, rel: 'abc-fe', path: join(m.root, 'abc-fe') });
  for (const bad of ['abc-fe/', 'abc-fe\\', '../abc-fe', join(m.root, 'abc-fe'), 'docs', 'ABC-FE', ' abc-fe']) {
    expect(resolveRepo(m.root, bad), bad).toEqual({ ok: false, code: 'git.unknownRepo', repos: ['abc-be', 'abc-fe'] });
  }
});
it('a plan root that is a repo ignores a repo name that is not "" (nothing to choose)', () => {
  const t = makeRepo(); bases.push(t.base);
  mkdirSync(join(t.repo, 'sub', '.git'), { recursive: true });
  writeFileSync(join(t.repo, 'sub', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  expect(discoverRepos(t.repo)).toEqual(['']);
  expect(resolveRepo(t.repo, 'sub')).toEqual({ ok: false, code: 'git.unknownRepo', repos: [''] });
});
it('repoPathOf joins a name to the plan root and maps "" to the root', () => {
  expect(repoPathOf('/p/root', '')).toMatch(/root$/);
  expect(repoPathOf('/p/root', undefined)).toBe(repoPathOf('/p/root', ''));
  expect(repoPathOf('/p/root', 'abc-fe').replace(/\\/g, '/')).toMatch(/root\/abc-fe$/);
});
