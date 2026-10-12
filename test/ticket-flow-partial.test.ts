import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitSync, makeRepo, removeDir, type TestRepo } from './git-helpers';
import { createAgentWorktree } from '../src/server/git/worktree';
import { DEFAULT_SECRET_PATTERNS } from '../src/server/git/secrets';
import { Inbox } from '../src/server/agents/inbox';
import { loadBundles } from '../src/server/i18n-bundles';
import { QuestionQueue } from '../src/server/questions/queue';
import { RequestStore } from '../src/server/requests/store';
import { Container } from '../src/server/runtime/container';
import type { Env } from '../src/server/runtime/env';
import type { Services } from '../src/server/runtime/services';
import { registerTicketFlow } from '../src/server/runtime/ticket-flow';
import { StateProblems } from '../src/server/state-problems';
import { createTranslator } from '../src/shared/i18n';
import { validateChecklist } from '../src/server/tickets/checklist';
import { runDirect } from '../src/server/tickets/test-queue';
import { TicketStore } from '../src/server/tickets/store';

vi.setConfig({ testTimeout: 90_000 });

/**
 * The reason the container exists: one area of the console assembled alone. Only `registerTicketFlow` is called; everything the
 * area reads from outside itself is a fake provided here, and no other area's factory is ever registered, let alone run.
 */
const ITEMS = ['Study the code', 'Tests first', 'Implement', 'Implement more', 'Validation', 'Update documentation'];
const PASS = 'node -e "process.exit(0)"';
// `review` is read only when a merge needs the user (a conflict), so this path never creates it.
const TICKET_FLOW_KEYS = ['ticketQueue', 'steps', 'requests', 'merge', 'central'];

let t: TestRepo;
let tickets: TicketStore;
let c: Container<Services>;
let created: (keyof Services)[];
let worktrees: Map<string, { worktree: string; branch: string }>;
let finished: string[];
let main: string[];
let stepsClosed: string[];

beforeEach(() => {
  t = makeRepo({ remote: true });
  tickets = new TicketStore(t.repo);
  worktrees = new Map();
  finished = []; main = []; stepsClosed = [];
  created = [];
  c = new Container<Services>({ onCreate: (key) => { created.push(key); } });

  const bundles = loadBundles();
  const shared = { testQueue: { position: () => undefined }, broadcastAll: () => undefined };
  const env = { o: { projectRoot: t.repo, projectName: 'p' }, shared, runtime: { git: { testTimeoutMinutes: 1 } }, config: { agents: { requestTimeoutMinutes: 5, requestMaxHops: 3 } } } as unknown as Env;
  const registry = {
    get: (slug: string) => { const git = worktrees.get(slug); return git ? { git, state: 'running', role: 'developer' } : undefined; },
    setGit: (slug: string, git: unknown) => { if (git === undefined) worktrees.delete(slug); },
  } as unknown as Services['registry'];
  const inbox = new Inbox();
  const originalPush = inbox.push.bind(inbox);
  inbox.push = (to, text) => { if (to === 'p') main.push(text); return originalPush(to, text); };

  // What the area reads from outside itself:
  c.provide('env', () => env);
  c.provide('projectName', () => 'p');
  c.provide('tickets', () => tickets);
  c.provide('registry', () => registry);
  c.provide('ptys', () => ({ status: () => 'running' }) as unknown as Services['ptys']);
  c.provide('inbox', () => inbox);
  c.provide('questions', () => new QuestionQueue());
  c.provide('store', () => ({ project: { squash: true }, listAgents: () => [] }) as unknown as Services['store']);
  c.provide('stateProblems', () => new StateProblems(t.repo));
  c.provide('requestStore', () => new RequestStore());
  c.provide('secretPatterns', () => () => DEFAULT_SECRET_PATTERNS);
  c.provide('testsDisabled', () => () => false);
  c.provide('testCommandAt', () => () => () => PASS);
  c.provide('testRunnerAt', () => () => runDirect);
  c.provide('reportLanguage', () => () => ({ lang: 'en', t: createTranslator({ lang: 'en', messages: bundles.get('en') ?? {}, fallback: bundles.get('en') }) }));
  c.provide('repoOfTicket', () => () => ({}));
  c.provide('endReadOnlySession', () => () => undefined);
  c.provide('finishAgent', () => async (slug: string) => { finished.push(slug); });
  c.provide('loop', () => ({ onStepDone: (slug: string) => { stepsClosed.push(slug); } }) as unknown as Services['loop']);

  registerTicketFlow(c);
});
afterEach(() => {
  if (created.includes('central')) c.get('central').cancel(); // merged() arms the settle timer of the central run
  removeDir(t.base);
});

async function worktreeFor(slug: string, files: Record<string, string>): Promise<{ path: string; branch: string }> {
  const w = await createAgentWorktree({ repo: t.repo, project: 'p', slug });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(w.path, name, '..'), { recursive: true });
    writeFileSync(join(w.path, name), content);
  }
  worktrees.set(slug, { worktree: w.path, branch: w.branch });
  return w;
}

describe('the ticket-flow area assembled alone', () => {
  it('sets a checklist, closes a step and merges an approved ticket, creating no other area', async () => {
    // steps: checklistSet and stepDone on a ticket in progress
    await worktreeFor('a', {});
    const set = await c.get('steps').checklistSet('a', ITEMS);
    expect(set.status).toBe('ok');
    const closed = await c.get('steps').stepDone('a', { n: 1, note: 'a decent note for this step' });
    expect(closed.status).toBe('closed');
    expect(tickets.progress('a')).toMatchObject({ done: 1, total: 6 });
    expect(stepsClosed).toEqual(['a']);

    // merge: an approved ticket with one commit of work
    const w = await worktreeFor('b', { 'src/b.js': 'b\n' });
    gitSync(w.path, 'add', '-A');
    gitSync(w.path, '-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', 'step 3/6: b');
    const sha = gitSync(w.path, 'rev-parse', 'HEAD');
    const r = validateChecklist(ITEMS);
    if (!r.ok) throw new Error(r.code);
    tickets.setChecklist('b', r.steps.map((s) => ({ ...s, done: true, note: s.n === 1 ? 'found the code' : undefined })));
    tickets.setGoal('b', 'Add the B module');
    tickets.setTests('b', { ok: true, command: PASS, tail: '', sha, at: '2026-10-05T10:00:00Z' });
    tickets.move('b', 'delivered', { deliveredSha: sha });
    tickets.move('b', 'in_review', { reviewer: 'review-b' });
    tickets.addVerdict('b', { pass: true, reviewer: 'review-b', notes: [] });
    tickets.move('b', 'approved');

    const merged = await c.get('merge').mergeTicket('b');
    expect(merged).toMatchObject({ status: 'merged' });
    expect(tickets.get('b')).toMatchObject({ status: 'merged' });
    expect(gitSync(t.repo, 'show', 'project/p:src/b.js')).toBe('b');
    expect(finished).toEqual(['b']);
    expect(existsSync(w.path)).toBe(false);
    expect(main.join('\n')).toMatch(/b.*merged/i);

    // only ticket-flow services were made by a factory of this area; the rest are the fakes read from outside
    const fakes = ['env', 'projectName', 'tickets', 'registry', 'ptys', 'inbox', 'questions', 'store', 'stateProblems', 'requestStore', 'secretPatterns', 'testsDisabled', 'testCommandAt', 'testRunnerAt', 'reportLanguage', 'repoOfTicket', 'endReadOnlySession', 'finishAgent', 'loop'];
    const fromTheArea = created.filter((k) => !fakes.includes(k));
    expect([...new Set(fromTheArea)].sort()).toEqual([...TICKET_FLOW_KEYS].sort());
    for (const other of ['budget', 'quota', 'scheduler', 'ctx', 'notify', 'review', 'recovery', 'release', 'onBudgetAnswer'] as const) expect(created).not.toContain(other);
  });
});
