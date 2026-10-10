import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { gitSync, makeRepo, removeDir, type TestRepo } from './git-helpers';
import { createCentralGit, pointedCommand } from '../src/server/tickets/central-git';
import { runValidation } from '../src/server/tickets/validate';
import { ensureProjectWorktree } from '../src/server/git/merge';
import { worktreesDirFor } from '../src/server/git/worktree';

vi.setConfig({ testTimeout: 60_000 });

let t: TestRepo;
beforeEach(() => { t = makeRepo(); });
afterEach(() => removeDir(t.base));

const commit = (cwd: string, file: string, body: string, msg: string): string => {
  writeFileSync(join(cwd, file), body);
  gitSync(cwd, 'add', '-A');
  gitSync(cwd, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', msg);
  return gitSync(cwd, 'rev-parse', 'HEAD');
};

it('re-runs on a temporary checkout of an intermediate merge and removes it afterwards; orders and lists touched files', async () => {
  const wt = await ensureProjectWorktree(t.repo, 'p', worktreesDirFor(t.repo, t.repo));
  if (!wt.ok) throw new Error('no project worktree');
  const a = commit(wt.path, 'a.txt', '1', 'ticket a');
  const b = commit(wt.path, 'bad.txt', '1', 'ticket b');
  const c = commit(wt.path, 'c.txt', '1', 'ticket c');
  const seen: string[] = [];
  const cg = createCentralGit({
    root: t.repo, project: 'p', timeoutMs: () => 30_000,
    runTests: (job) => { seen.push(job.cwd); return runValidation({ cwd: job.cwd, command: job.command, timeoutMs: job.timeoutMs }); },
    rerunCommand: () => 'node -e "process.exit(require(\'fs\').existsSync(\'bad.txt\')?1:0)"',
  });
  expect(await cg.rerun('', a, ['x.test.ts'], 'full')).toBe(true);
  expect(await cg.rerun('', b, ['x.test.ts'], 'full')).toBe(false);
  expect(await cg.rerun('', c, ['x.test.ts'], 'full')).toBe(false);
  expect(seen).toHaveLength(3);
  for (const dir of seen) expect(existsSync(dir)).toBe(false); // the temporary checkouts are gone
  expect(gitSync(t.repo, 'worktree', 'list')).not.toContain('central-bisect');

  const tickets = [{ slug: 'c', status: 'merged', mergedSha: c }, { slug: 'a', status: 'merged', mergedSha: a }, { slug: 'b', status: 'merged', mergedSha: b }];
  expect((await cg.order('', tickets)).map((x) => x.slug)).toEqual(['a', 'b', 'c']);
  expect(await cg.touched('', tickets[2]!)).toEqual(['bad.txt']);
  const prep = await cg.prepare('');
  expect(prep?.tip).toBe(c);
});

it('pointedCommand knows vitest and jest from package.json and refuses odd file names', () => {
  writeFileSync(join(t.repo, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^5' } }));
  expect(pointedCommand(t.repo, ['test/a.test.ts', 'test/b.test.ts'])).toBe('npx vitest run test/a.test.ts test/b.test.ts');
  expect(pointedCommand(t.repo, ['a.test.ts; rm -rf x'])).toBeUndefined();
  writeFileSync(join(t.repo, 'package.json'), JSON.stringify({ dependencies: {} }));
  expect(pointedCommand(t.repo, ['a.test.ts'])).toBeUndefined();
  rmSync(join(t.repo, 'package.json'));
  expect(pointedCommand(t.repo, ['a.test.ts'])).toBeUndefined();
});
