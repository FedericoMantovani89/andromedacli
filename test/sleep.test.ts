import { expect, it } from 'vitest';
import { BACKOFF_MINUTES, SleepTimer, type SleepState } from '../src/server/budget/sleep';
import { fakeSleepClock } from './helpers';

const MIN = 60_000;
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

function setup(answers: ('running' | 'limited' | 'reject' | 'hang')[] = []) {
  const fake = fakeSleepClock();
  const persisted: SleepState[] = [];
  const weekly: (string | undefined)[] = [];
  let changed = 0;
  let calls = 0;
  const hung: ((v: 'running' | 'limited') => void)[] = [];
  const timer = new SleepTimer({
    clock: fake.clock,
    wakeMain: () => {
      const a = answers[calls] ?? 'limited';
      calls += 1;
      if (a === 'reject') return Promise.reject(new Error('boom'));
      if (a === 'hang') return new Promise((ok) => { hung.push(ok); });
      return Promise.resolve(a);
    },
    persist: (s) => { persisted.push(s); },
    changed: () => { changed += 1; },
    weeklyNotice: (r) => { weekly.push(r); },
  });
  return { fake, timer, persisted, weekly, hung, calls: () => calls, changed: () => changed };
}

const at = (fake: { now(): number }, ms: number): string => new Date(fake.now() + ms).toISOString();

it('the backoff steps are 5, 10 and 20 minutes', () => expect([...BACKOFF_MINUTES]).toEqual([5, 10, 20]));

it('starts awake', () => {
  const { timer } = setup();
  expect(timer.state()).toEqual({ until: undefined, attempt: 0, phase: 'awake' });
});

it('sleeps until resetsAt: one timer, delay = resetsAt - now + 5 s', () => {
  const { fake, timer } = setup();
  timer.sleepUntil(at(fake, 2 * 60 * MIN), 'five_hour');
  expect(fake.timers.size).toBe(1);
  expect([...fake.timers.values()][0]!.ms).toBe(2 * 60 * MIN + 5000);
  expect(timer.state()).toMatchObject({ phase: 'sleeping', attempt: 0, kind: 'five_hour' });
  expect(timer.state().until).toBe(new Date(fake.now() + 2 * 60 * MIN + 5000).toISOString());
});

it.each([['missing', undefined], ['malformed', 'next tuesday'], ['past', '2020-01-01T00:00:00Z']])('a %s resetsAt schedules the first backoff step (5 min)', (_n, resetsAt) => {
  const { fake, timer } = setup();
  timer.sleepUntil(resetsAt, 'five_hour');
  expect(fake.timers.size).toBe(1);
  expect([...fake.timers.values()][0]!.ms).toBe(5 * MIN);
  expect(timer.state().phase).toBe('sleeping');
});

it('nothing is probed before the time: no attempt in the meantime', async () => {
  const { fake, timer, calls } = setup();
  timer.sleepUntil(at(fake, 60 * MIN), 'five_hour');
  fake.advance(60 * MIN); // the reset time itself: the margin is still to go
  await flush();
  expect(calls()).toBe(0);
  fake.advance(5000);
  await flush();
  expect(calls()).toBe(1);
});

it('at the wake-up wakeMain is called exactly once; running makes the timer awake and clears it', async () => {
  const { fake, timer, calls } = setup(['running']);
  timer.sleepUntil(at(fake, 10 * MIN), 'five_hour');
  fake.advance(10 * MIN + 5000);
  expect(timer.state().phase).toBe('probing');
  await flush();
  expect(calls()).toBe(1);
  expect(timer.state()).toEqual({ until: undefined, attempt: 0, phase: 'awake' });
  expect(fake.timers.size).toBe(0);
  fake.advance(24 * 60 * MIN);
  await flush();
  expect(calls()).toBe(1); // nothing else is ever scheduled
});

it('limited backs off 5 -> 10 -> 20 -> 20 minutes', async () => {
  const { fake, timer, calls } = setup(['limited', 'limited', 'limited', 'limited', 'running']);
  timer.sleepUntil(undefined, 'five_hour');
  const delays: number[] = [[...fake.timers.values()][0]!.ms];
  for (let i = 0; i < 4; i++) {
    fake.advance(delays.at(-1)!);
    await flush();
    expect(calls()).toBe(i + 1);
    expect(timer.state()).toMatchObject({ phase: i < 3 ? 'sleeping' : 'sleeping', attempt: i + 1 });
    expect(fake.timers.size).toBe(1);
    delays.push([...fake.timers.values()][0]!.ms);
  }
  expect(delays).toEqual([5 * MIN, 10 * MIN, 20 * MIN, 20 * MIN, 20 * MIN]);
  fake.advance(20 * MIN);
  await flush();
  expect(timer.state()).toEqual({ until: undefined, attempt: 0, phase: 'awake' });
});

it('a wakeMain that rejects counts as limited and backs off', async () => {
  const { fake, timer } = setup(['reject']);
  timer.sleepUntil(undefined, 'five_hour');
  fake.advance(5 * MIN);
  await flush();
  expect(timer.state()).toMatchObject({ phase: 'sleeping', attempt: 1 });
  expect([...fake.timers.values()][0]!.ms).toBe(10 * MIN);
});

it('a second sleepUntil while a probe is in flight does not start another', async () => {
  const { fake, timer, calls, hung } = setup(['hang']);
  timer.sleepUntil(undefined, 'five_hour');
  fake.advance(5 * MIN);
  expect(timer.state().phase).toBe('probing');
  timer.sleepUntil(at(fake, MIN), 'five_hour');
  timer.resumeNow();
  fake.advance(60 * MIN);
  await flush();
  expect(calls()).toBe(1);
  expect(fake.timers.size).toBe(0);
  hung[0]!('running');
  await flush();
  expect(timer.state().phase).toBe('awake');
});

it('a second sleepUntil while sleeping keeps the earlier timer', () => {
  const { fake, timer } = setup();
  const first = at(fake, 30 * MIN);
  timer.sleepUntil(first, 'five_hour');
  const before = timer.state();
  timer.sleepUntil(at(fake, 3 * 60 * MIN), 'five_hour');
  timer.sleepUntil(undefined, 'five_hour');
  expect(fake.timers.size).toBe(1);
  expect([...fake.timers.values()][0]!.ms).toBe(30 * MIN + 5000);
  expect(timer.state()).toEqual(before);
});

it('seven_day only calls weeklyNotice: no timer, and nothing restarts by itself', async () => {
  const { fake, timer, weekly, calls } = setup();
  const resets = at(fake, 3 * 24 * 60 * MIN);
  timer.sleepUntil(resets, 'seven_day');
  expect(weekly).toEqual([resets]);
  expect(fake.timers.size).toBe(0);
  expect(timer.state()).toMatchObject({ phase: 'sleeping', kind: 'seven_day', until: resets });
  fake.advance(10 * 24 * 60 * MIN);
  await flush();
  expect(calls()).toBe(0);
});

it('a weekly probe by the button that finds the limit still on schedules nothing', async () => {
  const { fake, timer, calls } = setup(['limited']);
  timer.sleepUntil(undefined, 'seven_day');
  timer.resumeNow();
  await flush();
  expect(calls()).toBe(1);
  expect(timer.state()).toMatchObject({ phase: 'sleeping', attempt: 1, kind: 'seven_day' });
  expect(fake.timers.size).toBe(0);
});

it('resumeNow probes at once and cancels the pending timer', async () => {
  const { fake, timer, calls } = setup(['running']);
  timer.sleepUntil(at(fake, 60 * MIN), 'five_hour');
  timer.resumeNow();
  expect(fake.timers.size).toBe(0);
  expect(timer.state().phase).toBe('probing');
  await flush();
  expect(calls()).toBe(1);
  expect(timer.state().phase).toBe('awake');
  fake.advance(2 * 60 * MIN);
  await flush();
  expect(calls()).toBe(1); // the cancelled timer never fires
});

it('resumeNow does nothing while awake', async () => {
  const { timer, calls } = setup();
  timer.resumeNow();
  await flush();
  expect(calls()).toBe(0);
});

it('persist and changed receive every state change', async () => {
  const { fake, timer, persisted, changed } = setup(['limited', 'running']);
  timer.sleepUntil(undefined, 'spend_limit');
  fake.advance(5 * MIN);
  await flush();
  fake.advance(10 * MIN);
  await flush();
  expect(persisted.map((s) => `${s.phase}:${s.attempt}`)).toEqual(['sleeping:0', 'probing:0', 'sleeping:1', 'probing:1', 'awake:0']);
  expect(changed()).toBe(persisted.length);
  expect(persisted[0]!.kind).toBe('spend_limit');
});

it('a persist that throws does not break the timer', async () => {
  const fake = fakeSleepClock();
  const timer = new SleepTimer({
    clock: fake.clock, wakeMain: async () => 'running', persist: () => { throw new Error('disk full'); },
    changed: () => { throw new Error('ui'); }, weeklyNotice: () => undefined,
  });
  timer.sleepUntil(undefined, 'five_hour');
  fake.advance(5 * MIN);
  await flush();
  expect(timer.state().phase).toBe('awake');
});

it('close cancels the pending timer; load shows a saved state without scheduling anything', () => {
  const { fake, timer } = setup();
  timer.sleepUntil(undefined, 'five_hour');
  timer.close();
  expect(fake.timers.size).toBe(0);
  const other = setup();
  other.timer.load({ until: '2026-10-05T12:00:00.000Z', kind: 'five_hour', attempt: 2, phase: 'probing' });
  expect(other.timer.state()).toMatchObject({ phase: 'sleeping', attempt: 2 });
  expect(other.fake.timers.size).toBe(0);
  expect(other.persisted).toEqual([]);
});

it('a weekly limit arriving while a five-hour timer is pending wins: no timer, the weekly state, one notice', () => {
  const { fake, timer, weekly } = setup();
  timer.sleepUntil(at(fake, 60 * MIN), 'five_hour');
  expect(fake.timers.size).toBe(1);
  const resets = at(fake, 3 * 24 * 60 * MIN);
  timer.sleepUntil(resets, 'seven_day');
  expect(fake.timers.size).toBe(0);
  expect(timer.state()).toMatchObject({ phase: 'sleeping', kind: 'seven_day', until: resets });
  timer.sleepUntil(resets, 'seven_day');
  timer.sleepUntil(at(fake, 4 * 24 * 60 * MIN), 'seven_day');
  expect(weekly).toEqual([resets]); // once per weekly sleep
});

it('a five-hour limit during a weekly sleep is ignored', () => {
  const { fake, timer } = setup();
  timer.sleepUntil(at(fake, 3 * 24 * 60 * MIN), 'seven_day');
  const before = timer.state();
  timer.sleepUntil(at(fake, 60 * MIN), 'five_hour');
  expect(fake.timers.size).toBe(0);
  expect(timer.state()).toEqual(before);
});

it('a weekly limit arriving during a probe is applied when the probe finds the limit still on', async () => {
  const { fake, timer, hung, weekly } = setup(['hang']);
  timer.sleepUntil(undefined, 'five_hour');
  fake.advance(5 * MIN);
  expect(timer.state().phase).toBe('probing');
  const resets = at(fake, 2 * 24 * 60 * MIN);
  timer.sleepUntil(resets, 'seven_day');
  expect(weekly).toEqual([resets]);
  hung[0]!('limited');
  await flush();
  expect(timer.state()).toMatchObject({ phase: 'sleeping', kind: 'seven_day', until: resets, attempt: 1 });
  expect(fake.timers.size).toBe(0);
});

it('lifted() ends a sleep: a pending timer and a weekly state go; nothing while awake or probing', async () => {
  const { fake, timer, calls } = setup(['hang']);
  timer.lifted(); // awake: nothing
  expect(timer.state().phase).toBe('awake');
  timer.sleepUntil(at(fake, 60 * MIN), 'five_hour');
  timer.lifted();
  expect(timer.state()).toEqual({ until: undefined, attempt: 0, phase: 'awake' });
  expect(fake.timers.size).toBe(0);
  timer.sleepUntil(at(fake, 3 * 24 * 60 * MIN), 'seven_day');
  timer.lifted();
  expect(timer.state().phase).toBe('awake');
  // while probing the probe's own reading decides
  timer.sleepUntil(undefined, 'five_hour');
  fake.advance(5 * MIN);
  expect(timer.state().phase).toBe('probing');
  timer.lifted();
  expect(timer.state().phase).toBe('probing');
  expect(calls()).toBe(1);
});

it('a reset 30 days away is not trusted: the backoff applies, no timer can overflow', () => {
  const { fake, timer } = setup();
  timer.sleepUntil(at(fake, 30 * 24 * 60 * MIN), 'five_hour');
  expect([...fake.timers.values()].map((t) => t.ms)).toEqual([5 * MIN]);
});

it('after close() a probe that settles schedules nothing', async () => {
  const { fake, timer, hung } = setup(['hang']);
  timer.sleepUntil(undefined, 'five_hour');
  fake.advance(5 * MIN);
  timer.close();
  hung[0]!('limited');
  await flush();
  expect(fake.timers.size).toBe(0);
  timer.sleepUntil(undefined, 'five_hour');
  expect(fake.timers.size).toBe(0);
});
