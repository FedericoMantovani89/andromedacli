import { expect, it } from 'vitest';
import { KeyedQueue } from '../src/server/keyed-queue';

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));
const withTimeout = <T>(p: Promise<T>, ms = 1000): Promise<T> => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timed out (a deadlock?)')), ms))]);

it('runs the calls of one key one after the other', async () => {
  const q = new KeyedQueue();
  const log: string[] = [];
  const job = (name: string, ms: number) => q.run('k', async () => { log.push(`${name} start`); await tick(ms); log.push(`${name} end`); });
  await Promise.all([job('a', 20), job('b', 1)]);
  expect(log).toEqual(['a start', 'a end', 'b start', 'b end']);
});

it('runs different keys in parallel', async () => {
  const q = new KeyedQueue();
  const log: string[] = [];
  await Promise.all([
    q.run('x', async () => { log.push('x start'); await tick(20); log.push('x end'); }),
    q.run('y', async () => { log.push('y start'); await tick(1); log.push('y end'); }),
  ]);
  expect(log).toEqual(['x start', 'y start', 'y end', 'x end']);
});

it('a failure does not block the next call, and its error reaches its own caller', async () => {
  const q = new KeyedQueue();
  const bad = q.run('k', async () => { throw new Error('boom'); });
  const good = q.run('k', async () => 'fine');
  await expect(bad).rejects.toThrow('boom');
  await expect(good).resolves.toBe('fine');
});

it('a nested call on the same key does not deadlock (Review Focus 1)', async () => {
  const q = new KeyedQueue();
  const out = await withTimeout(q.run('k', async () => (await q.run('k', async () => 'inner')) + ' outer'));
  expect(out).toBe('inner outer');
});

it('a nested call two levels down, through another key, does not deadlock either', async () => {
  const q = new KeyedQueue();
  const out = await withTimeout(q.run('a', async () => q.run('b', async () => q.run('a', async () => 'deep'))));
  expect(out).toBe('deep');
});

it('a call made later from a continuation that leaked out of a finished operation is serialized again (Review Focus 1)', async () => {
  const q = new KeyedQueue();
  const log: string[] = [];
  let leaked: Promise<void> | undefined;
  await q.run('k', async () => {
    setTimeout(() => { leaked = q.run('k', async () => { log.push('leaked start'); await tick(1); log.push('leaked end'); }); }, 15);
  });
  const long = q.run('k', async () => { log.push('long start'); await tick(60); log.push('long end'); });
  await tick(30); // the leaked timer has fired while `long` is running
  await Promise.all([long, leaked]);
  expect(log).toEqual(['long start', 'long end', 'leaked start', 'leaked end']);
});

it('forget() while an operation runs does not let the next call start in parallel', async () => {
  const q = new KeyedQueue();
  const log: string[] = [];
  const first = q.run('k', async () => { log.push('first start'); await tick(30); log.push('first end'); });
  q.forget('k');
  const second = q.run('k', async () => { log.push('second start'); });
  await Promise.all([first, second]);
  expect(log).toEqual(['first start', 'first end', 'second start']);
});

it('leaves nothing behind once the work is done', async () => {
  const q = new KeyedQueue();
  await Promise.all(Array.from({ length: 50 }, (_, i) => q.run(`ticket-${i}`, async () => i)));
  await q.run('last', async () => undefined);
  await tick();
  expect(q.pending).toBe(0);
});

it('a function that throws before it returns a promise is a rejection, not a throw, and does not leave the key held (review)', async () => {
  const q = new KeyedQueue();
  const bad = q.run('k', (() => { throw new Error('sync boom'); }) as () => Promise<never>);
  await expect(bad).rejects.toThrow('sync boom');
  await expect(q.run('k', async () => 'next')).resolves.toBe('next');
});

it('a nested call whose function throws synchronously is a rejection too, not a throw out of run() (review)', async () => {
  const q = new KeyedQueue();
  const out = await withTimeout(q.run('k', async () => {
    const p = q.run('k', (() => { throw new Error('inner boom'); }) as () => Promise<never>); // must not throw here
    return p.then(() => 'no error', (e: Error) => e.message);
  }));
  expect(out).toBe('inner boom');
});
