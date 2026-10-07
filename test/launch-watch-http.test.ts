import { expect, it } from 'vitest';
import { autoClose, bootServer, modEvent, mod, state, until } from './helpers';

autoClose();

const spawn = (s: Awaited<ReturnType<typeof bootServer>>, name: string) =>
  mod(s, 'shop-api', '/v1/tools/spawn_agent', 'POST', { name, profile: 'backend', goal: 'make it work' });
const mainInbox = async (s: Awaited<ReturnType<typeof bootServer>>): Promise<string[]> =>
  (await mod(s, 'shop-api', '/v1/inbox')).body.messages.map((m: { text: string }) => m.text);

it('an agent that never reports in is flagged and the main is told after the launch check', async () => {
  const s = await bootServer({ launchCheckMs: 150 });
  await spawn(s, 'fix-login');
  expect((await state(s)).agents[0].launchStalled).toBeUndefined();
  await until(async () => (await mainInbox(s)).some((t) => t.includes('fix-login')), 5000);
  const text = (await mainInbox(s)).find((t) => t.includes('fix-login'))!;
  expect(text).toMatch(/Launch check/);
  expect(text).toMatch(/has not started/);
  expect((await state(s)).agents[0].launchStalled).toBe(true);
  await modEvent(s, 'fix-login', 'session.start');
  await modEvent(s, 'fix-login', 'turn.start');
  expect((await state(s)).agents[0].launchStalled).toBeUndefined();
});
it('an agent that starts working in time causes no message', async () => {
  const s = await bootServer({ launchCheckMs: 300 });
  await spawn(s, 'fix-login');
  await modEvent(s, 'fix-login', 'session.start');
  await modEvent(s, 'fix-login', 'turn.start');
  await new Promise((r) => setTimeout(r, 700));
  expect((await mainInbox(s)).filter((t) => t.includes('Launch check'))).toEqual([]);
});
it('a queued agent is checked from when it actually starts, not from when it was asked for', async () => {
  const s = await bootServer({ launchCheckMs: 400 });
  s.setLimits({ global: 1, perProject: 1 });
  await spawn(s, 'first-job');
  await spawn(s, 'second-job');
  await modEvent(s, 'first-job', 'session.start');
  await modEvent(s, 'first-job', 'turn.start');
  await new Promise((r) => setTimeout(r, 600));
  expect((await mainInbox(s)).some((t) => t.includes('second-job'))).toBe(false); // still waiting in the queue: nothing to check
  await modEvent(s, 'first-job', 'turn.complete', { answer: 'done' });
  await until(async () => (await state(s)).agents.find((a: any) => a.slug === 'second-job')?.status === 'running', 5000);
  await until(async () => (await mainInbox(s)).some((t) => t.includes('second-job')), 5000);
});
it('shutdown does not leave a check that fires later', async () => {
  const s = await bootServer({ launchCheckMs: 200 });
  await spawn(s, 'fix-login');
  await s.close();
  await new Promise((r) => setTimeout(r, 400));
  expect(true).toBe(true); // reaching here without an unhandled error is the assertion
});
