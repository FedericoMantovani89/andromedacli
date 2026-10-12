import { expect, it } from 'vitest';
import { KeyedQueue } from '../src/server/keyed-queue';

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));
const withTimeout = <T>(p: Promise<T>, ms = 1000): Promise<T> => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timed out (a deadlock?)')), ms))]);

class FakeService {
  constructor(private readonly name: string, private readonly queue: KeyedQueue, private readonly log: string[]) {}
  async work(slug: string, ms: number, then?: () => Promise<void>): Promise<void> {
    return this.queue.run(slug, async () => {
      this.log.push(`${this.name} ${slug} start`);
      await tick(ms);
      if (then) await then();
      this.log.push(`${this.name} ${slug} end`);
    });
  }
}

it('two services sharing one queue never overlap on the same ticket', async () => {
  const q = new KeyedQueue();
  const log: string[] = [];
  const steps = new FakeService('steps', q, log);
  const budget = new FakeService('budget', q, log);
  await Promise.all([steps.work('fix-login', 20), budget.work('fix-login', 1)]);
  expect(log).toEqual(['steps fix-login start', 'steps fix-login end', 'budget fix-login start', 'budget fix-login end']);
});

it('they still work on different tickets at the same time', async () => {
  const q = new KeyedQueue();
  const log: string[] = [];
  const steps = new FakeService('steps', q, log);
  const review = new FakeService('review', q, log);
  await Promise.all([steps.work('a-1', 20), review.work('b-2', 1)]);
  expect(log.indexOf('review b-2 end')).toBeLessThan(log.indexOf('steps a-1 end'));
});

it('a review that starts a replacement, which asks the budget, which finishes the agent: all on one ticket, no deadlock', async () => {
  const q = new KeyedQueue();
  const log: string[] = [];
  const review = new FakeService('review', q, log);
  const recovery = new FakeService('recovery', q, log);
  const budget = new FakeService('budget', q, log);
  const steps = new FakeService('steps', q, log);
  await withTimeout(review.work('t-1', 1, () => recovery.work('t-1', 1, () => budget.work('t-1', 1, () => steps.work('t-1', 1)))));
  expect(log.filter((l) => l.endsWith('end')).length).toBe(4);
});

it('two operations that each ask another ticket wait their turn on it', async () => {
  const q = new KeyedQueue();
  const log: string[] = [];
  const s = new FakeService('s', q, log);
  await withTimeout(Promise.all([s.work('a-1', 5, () => s.work('b-2', 1)), s.work('c-3', 5, () => s.work('b-2', 1))]));
  expect(log.filter((l) => l.startsWith('s b-2')).length).toBe(4);
});
