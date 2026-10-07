import { it, expect } from 'vitest';
import { autoClose, bootServer, mod, modEvent, ui, until, state } from './helpers';

autoClose();

const spawn = (s: Awaited<ReturnType<typeof bootServer>>, name: string, goal: string) =>
  mod(s, 'shop-api', '/v1/tools/spawn_agent', 'POST', { name, profile: 'developer', goal });
const list = async (s: Awaited<ReturnType<typeof bootServer>>, as: string) => (await mod(s, as, '/v1/tools/list_agents', 'POST', {})).body.agents;

it('main and agents see the same list: everyone of the project with profile, state and goal', async () => {
  const s = await bootServer();
  await spawn(s, 'fix-login-timeout', 'Fix the login timeout');
  const fromMain = await list(s, 'shop-api');
  const fromAgent = await list(s, 'fix-login-timeout');
  expect(fromMain).toEqual(fromAgent);
  expect(fromMain).toEqual([
    { slug: 'shop-api', profile: 'main', role: 'main', state: 'starting' },
    { slug: 'fix-login-timeout', profile: 'developer', role: 'agent', state: 'starting', goal: 'Fix the login timeout' },
  ]);
});
it('a queued agent shows its position', async () => {
  const s = await bootServer();
  s.setLimits({ global: 1, perProject: 1 });
  await spawn(s, 'first-job', 'a'); await spawn(s, 'second-job', 'b'); await spawn(s, 'third-job', 'c');
  const agents = await list(s, 'shop-api');
  expect(agents.filter((a: any) => a.state === 'queued').map((a: any) => [a.slug, a.queuedPosition])).toEqual([['second-job', 1], ['third-job', 2]]);
});
it('follows events and a dead process', async () => {
  const s = await bootServer();
  await spawn(s, 'fix-login', 'x');
  await modEvent(s, 'fix-login', 'turn.start');
  expect((await list(s, 'shop-api')).find((a: any) => a.slug === 'fix-login').state).toBe('working');
  s.writeToSession('fix-login', 'quit\r');
  await until(async () => (await state(s)).agents[0].state === 'interrupted');
  expect((await list(s, 'shop-api')).find((a: any) => a.slug === 'fix-login').state).toBe('interrupted');
});
it('long goals are truncated to 300 characters', async () => {
  const s = await bootServer();
  await spawn(s, 'long-goal', 'g'.repeat(1000));
  const goal = (await list(s, 'shop-api')).find((a: any) => a.slug === 'long-goal').goal as string;
  expect(goal.length).toBeLessThanOrEqual(301);
  expect(goal.endsWith('…')).toBe(true);
});
it('needs a session token', async () => {
  const s = await bootServer();
  expect((await ui(s, '/v1/tools/list_agents', 'POST', {})).status).toBe(401);
});
