import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { gitSync, makeRepo, removeDir, type TestRepo } from './git-helpers';
import { createAgentWorktree } from '../src/server/git/worktree';
import { loadBundles } from '../src/server/i18n-bundles';
import { createTranslator } from '../src/shared/i18n';
import { TicketStore } from '../src/server/tickets/store';
import { validateChecklist } from '../src/server/tickets/checklist';
import { MergeService } from '../src/server/tickets/merge';
import { CentralRun } from '../src/server/tickets/central';
import { createCentralGit } from '../src/server/tickets/central-git';
import type { TestRun } from '../src/server/tickets/test-queue';

vi.setConfig({ testTimeout: 90_000 });

const bundles = loadBundles();
let t: TestRepo;
beforeEach(() => { t = makeRepo({ remote: true }); });
afterEach(() => removeDir(t.base));

it('a ticket merged by the real MergeService is covered by the central run, and a red run reaches its author when the session is still there', async () => {
  const tickets = new TicketStore(t.repo);
  const worktrees = new Map<string, { worktree: string; branch: string }>();
  const toAuthor: { slug: string; text: string }[] = [];
  const main: string[] = [];
  const cwds: string[] = [];
  let central: CentralRun;
  const merge = new MergeService({
    tickets, root: t.repo, project: 'p',
    worktreeOf: (slug) => worktrees.get(slug),
    testCommand: () => 'smoke', testTimeoutMs: () => 30_000, squash: () => true,
    runTests: async (): Promise<TestRun> => ({ ok: true, code: 0, tail: '' }),
    language: () => ({ lang: 'en', t: createTranslator({ lang: 'en', messages: bundles.get('en') ?? {}, fallback: bundles.get('en') }) }),
    authorAlive: () => true, notifyMain: () => {}, notifyAuthor: () => {}, needsUser: () => {},
    finishAgent: async () => {},
    merged: () => central.merged(),
  });
  central = new CentralRun({
    root: t.repo, project: 'p', tickets,
    command: () => 'full-suite', mergeCommand: () => 'smoke', timeoutMs: () => 30_000, settleMs: 0, merging: () => merge.inFlight(),
    git: createCentralGit({ root: t.repo, project: 'p', timeoutMs: () => 30_000, runTests: async () => ({ ok: true, code: 0, tail: '' }) }),
    runTests: async (job): Promise<TestRun> => { cwds.push(job.cwd); return { ok: false, code: 1, tail: ' FAIL  test/a.test.ts > breaks\nAssertionError: nope\n' }; },
    authorAlive: () => true,
    notifyAuthor: (slug, text) => { toAuthor.push({ slug, text }); },
    notifyMain: (text) => { main.push(text); },
    askUser: () => { throw new Error('the user must not be asked: the author is there'); },
  });

  const w = await createAgentWorktree({ repo: t.repo, project: 'p', slug: 'a-job' });
  mkdirSync(join(w.path, 'src'), { recursive: true });
  writeFileSync(join(w.path, 'src', 'a.js'), 'a\n');
  gitSync(w.path, 'add', '-A');
  gitSync(w.path, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', 'step 3/6');
  const sha = gitSync(w.path, 'rev-parse', 'HEAD');
  const r = validateChecklist(['Study the code', 'Tests first', 'Implement', 'Implement more', 'Validation', 'Update documentation']);
  if (!r.ok) throw new Error(r.code);
  tickets.setChecklist('a-job', r.steps.map((s) => ({ ...s, done: true, note: s.n === 1 ? 'found the code' : undefined })));
  tickets.setGoal('a-job', 'Add A');
  tickets.setTests('a-job', { ok: true, command: 'smoke', tail: '', sha, at: '2026-10-05T10:00:00Z' });
  tickets.move('a-job', 'delivered', { deliveredSha: sha });
  tickets.move('a-job', 'in_review', { reviewer: 'r' });
  tickets.addVerdict('a-job', { pass: true, reviewer: 'r', notes: [] });
  tickets.move('a-job', 'approved');
  worktrees.set('a-job', { worktree: w.path, branch: w.branch });

  expect(await merge.mergeTicket('a-job')).toMatchObject({ status: 'merged' });
  await new Promise((x) => setTimeout(x, 100)); // the settle timer
  await central.idle();

  expect(cwds).toHaveLength(1);
  expect(cwds[0]).not.toBe(join(t.repo, '.andromedaconsole', 'worktrees', '.project')); // a stable checkout of the tip, not the project worktree
  expect(toAuthor).toHaveLength(1);
  expect(toAuthor[0]!.slug).toBe('a-job');
  expect(toAuthor[0]!.text).toContain('test/a.test.ts');
  expect(toAuthor[0]!.text).toContain('AssertionError: nope');
  expect(tickets.get('a-job')!.central).toMatchObject({ red: { tests: ['test/a.test.ts'] } });
  expect(main.join('\n')).toContain('a-job');
  expect(central.record('')).toMatchObject({ ok: false, culprit: 'a-job', by: 'single' });
  expect(gitSync(t.repo, 'worktree', 'list')).not.toContain('central-run');
});
