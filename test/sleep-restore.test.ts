import { expect, it } from 'vitest';
import { SleepTimer, type SleepState } from '../src/server/budget/sleep';
import { fakeSleepClock } from './helpers';

const MIN = 60_000;
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

function setup() {
  const fake = fakeSleepClock();
  const probes: number[] = [];
  const timer = new SleepTimer({
    clock: fake.clock, wakeMain: () => { probes.push(fake.now()); return Promise.resolve('running' as const); },
    persist: () => undefined, changed: () => undefined, weeklyNotice: () => undefined,
  });
  return { fake, probes, timer };
}
const saved = (until: string | undefined, o: Partial<SleepState> = {}): SleepState => ({ until, attempt: 1, phase: 'sleeping', kind: 'five_hour', ...o });

it('a sleep whose time is ahead is re-armed for that time with the saved attempt', async () => {
  const { fake, probes, timer } = setup();
  timer.restore(saved(new Date(fake.now() + 30 * MIN).toISOString()));
  expect(timer.state()).toMatchObject({ phase: 'sleeping', attempt: 1 });
  fake.advance(29 * MIN);
  expect(probes).toEqual([]);
  fake.advance(2 * MIN);
  await flush();
  expect(probes).toHaveLength(1);
  expect(timer.state().phase).toBe('awake');
});
it('a time in the past probes at once', async () => {
  const { fake, probes, timer } = setup();
  timer.restore(saved(new Date(fake.now() - MIN).toISOString(), { phase: 'probing' }));
  await flush();
  expect(probes).toHaveLength(1);
});
it('a weekly sleep sets no timer and an awake state restores nothing', () => {
  const { fake, probes, timer } = setup();
  timer.restore(saved(new Date(fake.now() + 1000 * MIN).toISOString(), { kind: 'seven_day' }));
  expect(timer.state().kind).toBe('seven_day');
  expect(fake.timers.size).toBe(0);
  const other = setup();
  other.timer.restore({ until: undefined, attempt: 0, phase: 'awake' });
  expect(other.timer.state().phase).toBe('awake');
  expect(probes).toEqual([]);
});
