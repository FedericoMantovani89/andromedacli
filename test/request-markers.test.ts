import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { gitSync, makeRepo, removeDir, type TestRepo } from './git-helpers';
import { findMarkers } from '../src/server/requests/markers';

vi.setConfig({ testTimeout: 60_000 });

const repos: TestRepo[] = [];
afterEach(() => { while (repos.length) removeDir(repos.pop()!.base); });
const repo = (): TestRepo => { const t = makeRepo(); repos.push(t); return t; };

it('finds an untracked file and a tracked one, with file and line', async () => {
  const t = repo();
  writeFileSync(join(t.repo, 'a.ts'), 'const x = 1;\n// TODO-7f3a15 signature of POST /orders\n');
  writeFileSync(join(t.repo, 'README.md'), 'hello\n<!-- TODO-aaaaaa -->\n');
  gitSync(t.repo, 'add', 'README.md');
  const hits = await findMarkers(t.repo, ['TODO-7f3a15', 'TODO-aaaaaa']);
  expect(hits).toEqual(expect.arrayContaining([
    { file: 'a.ts', line: 2, id: 'TODO-7f3a15' },
    { file: 'README.md', line: 2, id: 'TODO-aaaaaa' },
  ]));
  expect(hits).toHaveLength(2);
});
it('finds nothing when the comment is gone, and nothing is asked when there are no ids', async () => {
  const t = repo();
  writeFileSync(join(t.repo, 'a.ts'), 'const x = 1;\n');
  expect(await findMarkers(t.repo, ['TODO-7f3a15'])).toEqual([]);
  expect(await findMarkers(t.repo, [])).toEqual([]);
});
it('ignores the console folder, which names the id in the checklist file', async () => {
  const t = repo();
  mkdirSync(join(t.repo, '.andromedaconsole'));
  writeFileSync(join(t.repo, '.andromedaconsole', 'checklist.md'), '- [ ] 3. Answer TODO-7f3a15\n');
  expect(await findMarkers(t.repo, ['TODO-7f3a15'])).toEqual([]);
});
it('does not take a failing git for "no comment found"', async () => {
  const t = repo();
  rmSync(t.repo, { recursive: true, force: true });
  expect(await findMarkers(t.repo, ['TODO-7f3a15'])).toBeUndefined();
});
