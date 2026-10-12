import { it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server/index';
import type { Runner } from '../src/server/prereq/checks';
import { Container } from '../src/server/runtime/container';
import type { Services, ProjectContainer } from '../src/server/runtime/services';
import { wire } from '../src/server/runtime/wiring';
import { registerLifecycle } from '../src/server/runtime/lifecycle';
import { BOOT_ORDER } from '../src/server/runtime/boot-order';

const fixture = join(__dirname, 'fixtures', 'fake-agent.cjs').replace(/\\/g, '/');
const goodRunner: Runner = async (cmd) => ({
  code: 0, stdout: cmd === 'node' ? 'v24.15.0' : cmd === 'git' ? 'git version 2.53.0' : '2.1.289 (Claude Code)',
});

/** The creation order of the services of the old function. One difference, harmless: `reader` (a TranscriptReader has no constructor and no effect) is now made on first use, by `budget`, instead of before `restrictions`. */
const ORDER_OF_TODAYS_CODE = [
  'stateProblems', 'store', 'previousRunWasClean', 'projectName', 'ptys', 'tokens', 'inbox', 'registry', 'questions', 'permissions', 'reading',
  'tickets', 'launchWatch', 'ticketQueue', 'review', 'central', 'merge', 'release', 'restrictions', 'turns', 'reader', 'budget', 'recovery',
  'onBudgetAnswer', 'loop', 'quota', 'resumer', 'waker', 'persister', 'staleChecker', 'guardLog', 'steps', 'requestStore', 'requests',
  'launchLog', 'scheduler', 'broadcast', 'notifier', 'presence', 'notify', 'ctx',
];

const running: Awaited<ReturnType<typeof startServer>>[] = [];
afterEach(async () => { vi.useRealTimers(); while (running.length) await running.pop()!.close(); });

it('creates the services of a project in the order the old function did', async () => {
  const created: string[] = [];
  const s = await startServer({
    prereqRunner: goodRunner, port: 0, projectRoot: mkdtempSync(join(tmpdir(), 'ord-project-')), configDir: mkdtempSync(join(tmpdir(), 'ord-cfg-')),
    projectName: 'shop-api', claudeCommand: [process.execPath, fixture], worktrees: false,
    containerOnCreate: (key) => { created.push(key); },
  });
  running.push(s);
  expect(created.filter((k) => ORDER_OF_TODAYS_CODE.includes(k))).toEqual(ORDER_OF_TODAYS_CODE);
  // Every service of the boot list exists, once.
  for (const k of BOOT_ORDER) expect(created.filter((x) => x === k)).toHaveLength(1);
});

// Hand-built fakes: the cast says "enough of the service for the code under test".
const fake = <T>(o: object): T => o as unknown as T;

function wiringFixture() {
  const log: string[] = [];
  const registryListeners: ((slug: string) => void)[] = [];
  const ctx = {};
  const otherRelease = vi.fn(() => { log.push('release-others'); });
  const c: ProjectContainer = new Container<Services>();
  c.provide('env', () => fake({
    shared: {
      pushToProject: () => undefined,
      runtimes: [{ ctx: {}, parts: { scheduler: { release: otherRelease } } }, { ctx, parts: { scheduler: { release: () => { log.push('release-self'); } } } }],
    },
  }));
  c.provide('projectName', () => 'p');
  c.provide('broadcast', () => () => { log.push('broadcast'); });
  c.provide('ctx', () => fake(ctx));
  c.provide('reading', () => fake({ on: () => { log.push('reading.on'); } }));
  c.provide('registry', () => fake({
    on: (fn: (slug: string) => void) => { log.push('registry.on'); registryListeners.push(fn); },
    get: () => undefined, list: () => [],
  }));
  c.provide('notify', () => fake({
    onRegistryChange: () => { log.push('notify'); },
    onItem: () => undefined,
    checkAvailability: () => { log.push('notify.checkAvailability'); return Promise.resolve(); },
  }));
  c.provide('persister', () => fake({ onChange: () => { log.push('persister'); } }));
  c.provide('questions', () => fake({ onAdd: () => { log.push('questions.onAdd'); }, onChange: () => { log.push('questions.onChange'); } }));
  c.provide('ptys', () => fake({ onExit: () => { log.push('ptys.onExit'); } }));
  c.provide('inbox', () => fake({ onPush: () => { log.push('inbox.onPush'); }, onAck: () => { log.push('inbox.onAck'); } }));
  c.provide('waker', () => fake({}));
  c.provide('requests', () => fake({}));
  c.provide('review', () => fake({}));
  c.provide('recovery', () => fake({}));
  c.provide('loop', () => fake({}));
  c.provide('tokens', () => fake({}));
  c.provide('tickets', () => fake({}));
  c.provide('restrictions', () => fake({}));
  c.provide('permissions', () => fake({}));
  c.provide('resumedAwaitingStart', () => new Set<string>());
  c.provide('ticketStatusOf', () => () => undefined);
  return { c, log, registryListeners };
}

it('wire registers the listeners in the old order, the four of the registry first to last', () => {
  const { c, log, registryListeners } = wiringFixture();
  wire(c);
  expect(log.filter((x) => x !== 'inbox.onPush' && x !== 'inbox.onAck')).toEqual([
    'reading.on', 'registry.on', 'registry.on', 'registry.on', 'questions.onAdd', 'notify.checkAvailability', 'registry.on', 'questions.onChange', 'ptys.onExit',
  ]);
  expect(log).toContain('inbox.onPush');
  expect(log).toContain('inbox.onAck');
  expect(registryListeners).toHaveLength(4);
  log.length = 0;
  for (const fn of registryListeners) fn('a');
  // broadcast, then the other projects' schedulers (not this one's), then the notifications, then the persistence.
  expect(log).toEqual(['broadcast', 'release-others', 'notify', 'persister']);
});

it('close clears every interval and timer it owns and runs its steps in the old order', async () => {
  vi.useFakeTimers();
  const log: string[] = [];
  const step = (name: string) => (): void => { log.push(name); };
  const wakeTimers = new Set<unknown>();
  const endTimers = new Set<ReturnType<typeof setTimeout>>();
  const sleepClock = {
    now: () => Date.now(),
    setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
    clearTimeout: (h: unknown): void => { log.push('wake-timer-cleared'); clearTimeout(h as ReturnType<typeof setTimeout>); },
  };
  const c: ProjectContainer = new Container<Services>();
  c.provide('env', () => fake({ o: { projectRoot: '/r', projectName: 'p', tickMs: 1000 }, sleepClock }));
  c.provide('projectName', () => 'p');
  c.provide('broadcast', () => () => undefined);
  c.provide('registry', () => fake({ list: () => [] }));
  const ticks: string[] = [];
  c.provide('budget', () => fake({ tick: () => { ticks.push('budget'); return Promise.resolve(); }, reportFailure: () => undefined }));
  c.provide('requests', () => fake({ tick: () => { ticks.push('requests'); } }));
  c.provide('loop', () => fake({ tick: () => { ticks.push('loop'); }, silentFor: () => undefined }));
  c.provide('notify', () => fake({ close: step('notify.close') }));
  c.provide('persister', () => fake({ close: step('persister.close') }));
  c.provide('inbox', () => fake({ freeze: step('inbox.freeze') }));
  c.provide('resumer', () => fake({ close: step('resumer.close') }));
  c.provide('launchWatch', () => fake({ close: step('launchWatch.close') }));
  c.provide('central', () => fake({ cancel: step('central.cancel') }));
  c.provide('scheduler', () => fake({ close: step('scheduler.close') }));
  c.provide('ptys', () => fake({ killAll: () => { log.push('ptys.killAll'); return Promise.resolve(); } }));
  c.provide('store', () => fake({ writeCleanStop: (clean: boolean) => { log.push(`writeCleanStop(${clean})`); } }));
  c.provide('wakeTimers', () => wakeTimers);
  c.provide('endTimers', () => endTimers);
  c.provide('quotaWaiters', () => new Set<() => void>());
  registerLifecycle(c);

  c.get('budgetTick');
  const staleTimer = setInterval(() => undefined, 60_000);
  c.get('staleTimerRef').value = staleTimer;
  wakeTimers.add(sleepClock.setTimeout(() => undefined, 5_000));
  endTimers.add(setTimeout(() => undefined, 5_000));
  expect(vi.getTimerCount()).toBe(4);
  vi.advanceTimersByTime(1000);
  expect(ticks).toEqual(['budget', 'requests', 'loop']); // the budget tick runs first, as before

  await c.get('close')();
  expect(vi.getTimerCount()).toBe(0);
  expect(log).toEqual([
    'notify.close', 'persister.close', 'inbox.freeze', 'resumer.close', 'wake-timer-cleared', 'launchWatch.close', 'central.cancel',
    'scheduler.close', 'ptys.killAll', 'writeCleanStop(true)',
  ]);
  expect(wakeTimers.size).toBe(0);
  expect(endTimers.size).toBe(0);
});
