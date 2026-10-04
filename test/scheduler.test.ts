import { it, expect, vi } from 'vitest';
import { AgentRegistry } from '../src/server/agents/registry';
import { Scheduler, type SpawnRequest } from '../src/server/agents/scheduler';

const req = (slug: string): SpawnRequest => ({ slug, profile: 'backend', goal: `goal of ${slug}`, source: 'main' });

function setup(limit: number, opts: { failFor?: string } = {}) {
  const registry = new AgentRegistry();
  const limits = { global: limit, perPlan: limit };
  const started: string[] = [];
  const errors: string[] = [];
  const start = vi.fn((r: SpawnRequest) => {
    if (r.slug === opts.failFor) throw new Error('boom');
    registry.register({ slug: r.slug, role: 'agent', profile: r.profile, goal: r.goal });
    registry.onSpawned(r.slug);
    started.push(r.slug);
  });
  const scheduler = new Scheduler({ registry, limits: () => limits, start, onStartError: (r) => { errors.push(r.slug); } });
  const finish = (slug: string) => {           // the agent completes its goal: starting -> idle -> working -> idle
    registry.onModEvent(slug, { type: 'session.start', sessionId: 's' });
    registry.onModEvent(slug, { type: 'turn.start', sessionId: 's' });
    registry.onModEvent(slug, { type: 'turn.complete', sessionId: 's' });
  };
  return { registry, limits, started, errors, start, scheduler, finish };
}

it('starts requests under the limit and queues the rest with positions', () => {
  const { scheduler, started } = setup(1);
  expect(scheduler.request(req('a-job'))).toEqual({ status: 'started' });
  expect(scheduler.request(req('b-job'))).toEqual({ status: 'queued', position: 1 });
  expect(scheduler.request(req('c-job'))).toEqual({ status: 'queued', position: 2 });
  expect(started).toEqual(['a-job']);
  expect(scheduler.queued().map((r) => r.slug)).toEqual(['b-job', 'c-job']);
});
it('starts the oldest queued request by itself when a slot frees (FIFO)', () => {
  const { scheduler, started, finish } = setup(1);
  scheduler.request(req('a-job')); scheduler.request(req('b-job')); scheduler.request(req('c-job'));
  finish('a-job');
  expect(started).toEqual(['a-job', 'b-job']);
  finish('b-job');
  expect(started).toEqual(['a-job', 'b-job', 'c-job']);
});
it('an agent waiting for the user does not hold a slot', () => {
  const { scheduler, started, registry } = setup(1);
  scheduler.request(req('a-job'));
  registry.onModEvent('a-job', { type: 'session.start', sessionId: 's' });
  registry.onModEvent('a-job', { type: 'turn.start', sessionId: 's' });
  scheduler.request(req('b-job'));
  expect(started).toEqual(['a-job']);
  registry.setWaitingUser('a-job', true);
  expect(started).toEqual(['a-job', 'b-job']);
});
it('a process that dies frees its slot', () => {
  const { scheduler, started, registry } = setup(1);
  scheduler.request(req('a-job')); scheduler.request(req('b-job'));
  registry.onModEvent('a-job', { type: 'turn.start', sessionId: 's' });
  registry.onProcessExit('a-job');
  expect(started).toEqual(['a-job', 'b-job']);
});
it('lowering the limit stops nobody and admits nobody until there is room', () => {
  const { scheduler, started, limits, registry, finish } = setup(3);
  scheduler.request(req('a-job')); scheduler.request(req('b-job')); scheduler.request(req('c-job'));
  limits.global = 1; limits.perPlan = 1;
  expect(registry.list().every((a) => a.state === 'starting')).toBe(true); // nothing was stopped
  expect(scheduler.request(req('d-job'))).toEqual({ status: 'queued', position: 1 });
  finish('a-job');  // 2 active (b, c) > limit 1: still no room
  expect(started).toEqual(['a-job', 'b-job', 'c-job']);
  finish('b-job');  // 1 active (c) = limit: no room yet
  expect(started).toEqual(['a-job', 'b-job', 'c-job']);
  finish('c-job');  // 0 active: d starts
  expect(started).toEqual(['a-job', 'b-job', 'c-job', 'd-job']);
});
it('the smaller of the global and per-plan limits applies', () => {
  const { scheduler, limits } = setup(5);
  limits.global = 4; limits.perPlan = 1;
  scheduler.request(req('a-job'));
  expect(scheduler.request(req('b-job'))).toEqual({ status: 'queued', position: 1 });
});
it('a start that throws is reported and neither leaks the slot nor blocks the queue', () => {
  const { scheduler, started, errors, finish } = setup(1, { failFor: 'b-job' });
  scheduler.request(req('a-job')); scheduler.request(req('b-job')); scheduler.request(req('c-job'));
  finish('a-job');
  expect(errors).toEqual(['b-job']);
  expect(started).toEqual(['a-job', 'c-job']);
});
it('a request whose start throws immediately propagates the error and leaves nothing queued', () => {
  const { scheduler } = setup(2, { failFor: 'x-job' });
  expect(() => scheduler.request(req('x-job'))).toThrow('boom');
  expect(scheduler.queued()).toEqual([]);
});
it('cancel removes a queued request and renumbers the others', () => {
  const { scheduler } = setup(1);
  scheduler.request(req('a-job')); scheduler.request(req('b-job')); scheduler.request(req('c-job'));
  scheduler.cancel('b-job');
  expect(scheduler.queued().map((r) => r.slug)).toEqual(['c-job']);
  expect(scheduler.position('c-job')).toBe(1);
  expect(scheduler.position('ghost-job')).toBeUndefined();
});
it('repeated release never starts the same request twice', () => {
  const { scheduler, started, finish } = setup(1);
  scheduler.request(req('a-job')); scheduler.request(req('b-job'));
  finish('a-job');
  scheduler.release(); scheduler.release();
  expect(started).toEqual(['a-job', 'b-job']);
});

it('after close nothing is started, not even when a slot frees (shutdown must not launch queued agents)', () => {
  const { scheduler, started, finish } = setup(1);
  scheduler.request(req('a-job')); scheduler.request(req('b-job'));
  scheduler.close();
  finish('a-job');
  expect(started).toEqual(['a-job']);
  expect(() => scheduler.request(req('c-job'))).toThrow(/closing/);
});

it('an asynchronous start counts as active at once, and its failure reaches the caller through `ready`', async () => {
  const registry = new AgentRegistry();
  const errors: string[] = [];
  let release!: (ok: boolean) => void;
  const scheduler = new Scheduler({
    registry, limits: () => ({ global: 1, perPlan: 1 }),
    start: (r) => {
      registry.register({ slug: r.slug, role: 'agent', profile: r.profile, goal: r.goal });
      registry.onSpawned(r.slug); // synchronous part: the slot is taken
      return new Promise<void>((ok, no) => { release = (good) => (good ? ok() : no(new Error('worktree failed'))); });
    },
    onStartError: (r) => { errors.push(r.slug); },
  });
  const first = scheduler.request(req('a-job'));
  expect(first.status).toBe('started');
  expect(scheduler.request(req('b-job'))).toEqual({ status: 'queued', position: 1 }); // the slot is already taken
  const ready = (first as { ready: Promise<void> }).ready;
  release(false);
  await expect(ready).rejects.toThrow('worktree failed');
  expect(errors).toEqual([]); // a failure on the direct path belongs to the caller
});
it('a queued request whose asynchronous start fails goes to onStartError and the queue goes on', async () => {
  const registry = new AgentRegistry();
  const errors: string[] = [];
  const started: string[] = [];
  const scheduler = new Scheduler({
    registry, limits: () => ({ global: 1, perPlan: 1 }),
    start: async (r) => {
      registry.register({ slug: r.slug, role: 'agent', profile: r.profile, goal: r.goal });
      registry.onSpawned(r.slug);
      if (r.slug === 'bad-job') { registry.onProcessExit(r.slug); throw new Error('nope'); }
      started.push(r.slug);
    },
    onStartError: (r) => { errors.push(r.slug); },
  });
  scheduler.request(req('a-job'));
  scheduler.request(req('bad-job'));
  scheduler.request(req('c-job'));
  registry.onProcessExit('a-job');
  await new Promise((r) => setTimeout(r, 20));
  expect(errors).toEqual(['bad-job']);
  expect(started).toEqual(['a-job', 'c-job']);
});
