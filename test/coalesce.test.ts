import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { coalesce } from '../src/server/coalesce';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it('a hundred triggers inside the window make one call, after the window', () => {
  const calls: number[] = [];
  const c = coalesce(() => { calls.push(Date.now()); }, 25);
  for (let i = 0; i < 100; i += 1) c.trigger();
  expect(calls).toEqual([]);
  vi.advanceTimersByTime(24);
  expect(calls).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(calls).toHaveLength(1);
});
it('a trigger after the call starts a new window: the last change is never lost', () => {
  let calls = 0;
  const c = coalesce(() => { calls += 1; }, 25);
  c.trigger();
  vi.advanceTimersByTime(25);
  expect(calls).toBe(1);
  c.trigger(); // the change that comes right after
  vi.advanceTimersByTime(25);
  expect(calls).toBe(2);
});
it('a trigger made while the call runs is served by the next one', () => {
  let calls = 0;
  const c = coalesce(() => { calls += 1; if (calls === 1) c.trigger(); }, 25);
  c.trigger();
  vi.advanceTimersByTime(25);
  expect(calls).toBe(1);
  vi.advanceTimersByTime(25);
  expect(calls).toBe(2);
});
it('cancel drops the waiting call', () => {
  let calls = 0;
  const c = coalesce(() => { calls += 1; }, 25);
  c.trigger();
  c.cancel();
  vi.advanceTimersByTime(100);
  expect(calls).toBe(0);
  c.trigger(); // and it still works afterwards
  vi.advanceTimersByTime(25);
  expect(calls).toBe(1);
});
