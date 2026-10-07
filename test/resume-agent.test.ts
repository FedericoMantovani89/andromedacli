// The resume_agent rules (SPEC 18.4): only tickets suspended for the limit, with a session to resume and a worktree; nothing while the
// quota is high; staggered groups on an injectable clock; the ticket is restarted before each launch.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ResumeService } from '../src/server/agents/resume';
import { AgentRegistry } from '../src/server/agents/registry';
import { TicketStore } from '../src/server/tickets/store';

const QUOTA = { halvePercent: 70, freezePercent: 85, stopPercent: 95, staggerSeconds: 60, staggerGroup: 2 };

interface SetupOptions {
  percent?: number;
  suspended?: string[];
  inProgress?: string[];
  noSession?: string[];
  noWorktree?: string[];
  launchResult?: (name: string) => { ok: true } | { ok: false; code: string };
}

function setup(o: SetupOptions = {}) {
  const tickets = new TicketStore(mkdtempSync(join(tmpdir(), 'resume-')));
  const registry = new AgentRegistry();
  const add = (name: string, suspend: boolean) => {
    tickets.setChecklist(name, []);
    if (suspend) tickets.move(name, 'suspended_limit');
    registry.register({ slug: name, role: 'agent', profile: 'developer', goal: `goal of ${name}` });
    if (!o.noSession?.includes(name)) registry.onModEvent(name, { type: 'session.start', sessionId: `sess-${name}` });
  };
  for (const name of o.suspended ?? []) add(name, true);
  for (const name of o.inProgress ?? []) add(name, false);
  const timers: { id: number; ms: number; fn: () => void }[] = [];
  let nextId = 1;
  let now = 0;
  const launches: { name: string; sessionId: string; status: string | undefined; at: number }[] = [];
  const told: string[] = [];
  let changed = 0;
  let percent = o.percent;
  const service = new ResumeService({
    tickets, registry,
    config: () => QUOTA,
    quotaWorst: () => (percent === undefined ? undefined : { percent }),
    clock: {
      now: () => now,
      setTimeout: (fn, ms) => { const id = nextId++; timers.push({ id, ms, fn }); return id; },
      clearTimeout: (h) => { const i = timers.findIndex((x) => x.id === h); if (i >= 0) timers.splice(i, 1); },
    },
    launch: async (name, sessionId) => {
      launches.push({ name, sessionId, status: tickets.get(name)?.status, at: now });
      return o.launchResult ? o.launchResult(name) : { ok: true };
    },
    suspendedTickets: () => tickets.list().filter((t) => t.status === 'suspended_limit').map((t) => t.slug),
    hasWorktree: (name) => !o.noWorktree?.includes(name),
    tellMain: (text) => { told.push(text); },
    changed: () => { changed += 1; },
  });
  /** Fires the timer set for `ms` and moves the clock there. */
  const fire = (ms: number) => {
    const i = timers.findIndex((t) => t.ms === ms);
    if (i < 0) throw new Error(`no timer at ${ms}`);
    const [t] = timers.splice(i, 1);
    now = ms;
    t!.fn();
  };
  return { service, tickets, registry, timers, launches, told, fire, changed: () => changed, setPercent: (p: number) => { percent = p; } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

it('refuses everything while the quota is at 88% (at or above the freeze threshold), and starts nothing', async () => {
  const t = setup({ percent: 88, suspended: ['job-a', 'job-b'] });
  const out = t.service.resume(['job-a', 'job-b']);
  expect(out).toMatchObject({ status: 'refused', code: 'quota_high' });
  await flush();
  expect(t.launches).toEqual([]);
  expect(t.timers).toEqual([]);
  expect(t.tickets.get('job-a')!.status).toBe('suspended_limit');
  // exactly at the threshold is refused too; just below it is not
  t.setPercent(85);
  expect(t.service.resume(['job-a'])).toMatchObject({ status: 'refused', code: 'quota_high' });
  t.setPercent(84);
  expect(t.service.resume(['job-a'])).toMatchObject({ status: 'ok', started: ['job-a'] });
});

it('refuses a ticket that is in_progress (not suspended), and nothing else of the call starts', async () => {
  const t = setup({ percent: 10, suspended: ['job-a'], inProgress: ['job-b'] });
  expect(t.service.resume(['job-a', 'job-b'])).toEqual({ status: 'refused', code: 'not_suspended', detail: 'job-b' });
  await flush();
  expect(t.launches).toEqual([]);
  expect(t.tickets.get('job-a')!.status).toBe('suspended_limit');
});

it('refuses a suspended ticket whose agent has no recorded session id (it needs recovery, not resume)', async () => {
  const t = setup({ percent: 10, suspended: ['job-a'], noSession: ['job-a'] });
  expect(t.service.resume(['job-a'])).toEqual({ status: 'refused', code: 'no_session', detail: 'job-a' });
  await flush();
  expect(t.launches).toEqual([]);
});

it('refuses a suspended ticket whose worktree is gone', async () => {
  const t = setup({ percent: 10, suspended: ['job-a'], noWorktree: ['job-a'] });
  expect(t.service.resume(['job-a'])).toEqual({ status: 'refused', code: 'no_worktree', detail: 'job-a' });
});

it('an unknown name is not_suspended', () => {
  const t = setup({ percent: 10, suspended: ['job-a'] });
  expect(t.service.resume(['no-such-job'])).toEqual({ status: 'refused', code: 'not_suspended', detail: 'no-such-job' });
});

it('with quota at 10%, staggerGroup 2 and 5 names: 2 start now, the rest at 60 s and 120 s, each after tickets.restart', async () => {
  const names = ['job-a', 'job-b', 'job-c', 'job-d', 'job-e'];
  const t = setup({ percent: 10, suspended: names });
  const out = t.service.resume(names);
  expect(out).toEqual({
    status: 'ok', started: ['job-a', 'job-b'],
    scheduled: [{ name: 'job-c', inSeconds: 60 }, { name: 'job-d', inSeconds: 60 }, { name: 'job-e', inSeconds: 120 }],
  });
  await flush();
  // the first group: restarted (in_progress) before its launch, with its own session id
  expect(t.launches).toEqual([
    { name: 'job-a', sessionId: 'sess-job-a', status: 'in_progress', at: 0 },
    { name: 'job-b', sessionId: 'sess-job-b', status: 'in_progress', at: 0 },
  ]);
  expect(t.timers.map((x) => x.ms)).toEqual([60_000, 120_000]);
  expect(t.tickets.get('job-c')!.status).toBe('suspended_limit'); // untouched until its group
  // asking again for a name already scheduled is refused
  expect(t.service.resume(['job-c'])).toMatchObject({ status: 'refused', code: 'not_suspended' });
  t.fire(60_000);
  await flush();
  expect(t.launches.slice(2)).toEqual([
    { name: 'job-c', sessionId: 'sess-job-c', status: 'in_progress', at: 60_000 },
    { name: 'job-d', sessionId: 'sess-job-d', status: 'in_progress', at: 60_000 },
  ]);
  expect(t.tickets.get('job-e')!.status).toBe('suspended_limit');
  t.fire(120_000);
  await flush();
  expect(t.launches.slice(4)).toEqual([{ name: 'job-e', sessionId: 'sess-job-e', status: 'in_progress', at: 120_000 }]);
  for (const n of names) expect(t.tickets.get(n)!.status, n).toBe('in_progress');
  expect(t.told).toEqual([]);
  expect(t.changed()).toBeGreaterThan(0);
});

it('the same name twice in one call starts once', async () => {
  const t = setup({ percent: 10, suspended: ['job-a'] });
  expect(t.service.resume(['job-a', 'job-a'])).toEqual({ status: 'ok', started: ['job-a'], scheduled: [] });
  await flush();
  expect(t.launches).toHaveLength(1);
});

it('a restart clears a stale blocked reason', async () => {
  const t = setup({ percent: 10, suspended: [] });
  t.tickets.setChecklist('job-a', []);
  t.tickets.block('job-a', 'waiting for the schema');
  t.tickets.move('job-a', 'suspended_limit');
  t.registry.register({ slug: 'job-a', role: 'agent', profile: 'developer' });
  t.registry.onModEvent('job-a', { type: 'session.start', sessionId: 'sess-job-a' });
  expect(t.service.resume(['job-a'])).toMatchObject({ status: 'ok' });
  const ticket = t.tickets.get('job-a')!;
  expect(ticket.status).toBe('in_progress');
  expect(ticket.blocked).toBe(false);
  expect(ticket.blockedReason).toBeUndefined();
});

it('a launch that fails puts the ticket back in suspended_limit and tells the main', async () => {
  const t = setup({ percent: 10, suspended: ['job-a'], launchResult: () => ({ ok: false, code: 'no_worktree' }) });
  expect(t.service.resume(['job-a'])).toMatchObject({ status: 'ok', started: ['job-a'] });
  await flush();
  expect(t.tickets.get('job-a')!.status).toBe('suspended_limit');
  expect(t.told).toHaveLength(1);
  expect(t.told[0]).toMatch(/job-a.*no_worktree/);
});

it('an unknown quota (no reading yet) does not block a resume', async () => {
  const t = setup({ suspended: ['job-a'] });
  expect(t.service.resume(['job-a'])).toMatchObject({ status: 'ok', started: ['job-a'] });
});

it('the staggering holds across calls: a second call right after the first is scheduled after the pause, not started', async () => {
  const t = setup({ percent: 10, suspended: ['job-a', 'job-b', 'job-c', 'job-d'] });
  expect(t.service.resume(['job-a', 'job-b'])).toEqual({ status: 'ok', started: ['job-a', 'job-b'], scheduled: [] });
  expect(t.service.resume(['job-c', 'job-d'])).toEqual({
    status: 'ok', started: [], scheduled: [{ name: 'job-c', inSeconds: 60 }, { name: 'job-d', inSeconds: 60 }],
  });
  await flush();
  expect(t.launches.map((l) => l.name)).toEqual(['job-a', 'job-b']);
  expect(t.tickets.get('job-c')!.status).toBe('suspended_limit');
  expect(t.timers.map((x) => x.ms)).toEqual([60_000]);
  t.fire(60_000);
  await flush();
  expect(t.launches.map((l) => l.name)).toEqual(['job-a', 'job-b', 'job-c', 'job-d']);
});

it('a group whose turn comes while the quota is at the freeze threshold is not started and the main is told', async () => {
  const t = setup({ percent: 10, suspended: ['job-a', 'job-b', 'job-c'] });
  expect(t.service.resume(['job-a', 'job-b', 'job-c'])).toMatchObject({ status: 'ok', started: ['job-a', 'job-b'] });
  t.setPercent(88);
  t.fire(60_000);
  await flush();
  expect(t.launches.map((l) => l.name)).toEqual(['job-a', 'job-b']);
  expect(t.tickets.get('job-c')!.status).toBe('suspended_limit');
  expect(t.told).toHaveLength(1);
  expect(t.told[0]).toMatch(/job-c.*88%/);
  // it can be asked again once the quota is lower
  t.setPercent(10);
  expect(t.service.resume(['job-c'])).toMatchObject({ status: 'ok' });
});

it('close() cancels the groups still waiting', () => {
  const t = setup({ percent: 10, suspended: ['job-a', 'job-b', 'job-c'] });
  t.service.resume(['job-a', 'job-b', 'job-c']);
  expect(t.timers).toHaveLength(1);
  t.service.close();
  expect(t.timers).toHaveLength(0);
});
