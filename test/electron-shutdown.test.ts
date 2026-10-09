import { expect, it } from 'vitest';
import { createShutdownGate } from '../src/electron/shutdown';

function deferred() {
  let done!: () => void;
  let fail!: (e: Error) => void;
  const promise = new Promise<void>((ok, bad) => { done = ok; fail = bad; });
  return { promise, done, fail };
}

it('holds a close or quit back until the stop has finished, whatever the user does meanwhile', async () => {
  const stop = deferred();
  const calls: string[] = [];
  const gate = createShutdownGate({ stop: () => { calls.push('stop'); return stop.promise; }, exit: () => { calls.push('exit'); } });
  expect(gate.blocks()).toBe(true); // nothing has been stopped yet: the app may not just close
  expect(gate.stopping()).toBe(false);
  const first = gate.stopAndExit();
  const second = gate.stopAndExit(); // a second close while the first stop is running
  expect(gate.stopping()).toBe(true);
  expect(gate.blocks()).toBe(true);
  expect(calls).toEqual(['stop']); // one stop, and no exit yet
  stop.done();
  await Promise.all([first, second]);
  expect(calls).toEqual(['stop', 'exit']);
  expect(gate.blocks()).toBe(false);
});

it('exits even when the stop fails (a stuck project must not keep the window frozen)', async () => {
  const stop = deferred();
  const calls: string[] = [];
  const gate = createShutdownGate({ stop: () => stop.promise, exit: () => { calls.push('exit'); } });
  const run = gate.stopAndExit();
  stop.fail(new Error('boom'));
  await run;
  expect(calls).toEqual(['exit']);
  expect(gate.blocks()).toBe(false);
});

it('stop() alone (the update restart) stops once and lets the app quit by itself afterwards, without exiting', async () => {
  const calls: string[] = [];
  const gate = createShutdownGate({ stop: async () => { calls.push('stop'); }, exit: () => { calls.push('exit'); } });
  await gate.stop();
  await gate.stop();
  expect(calls).toEqual(['stop']);
  expect(gate.blocks()).toBe(false);
  await gate.stopAndExit(); // already stopped: only the exit remains
  expect(calls).toEqual(['stop', 'exit']);
});
