import { expect, it } from 'vitest';
import { autoClose, usePipePty, bootServer, modEvent, req, ui } from './helpers';

autoClose();
usePipePty(); // this file never reads the terminal: its sessions run on plain pipes

it('the archive routes need the token, name a known agent, and refuse an agent that is not finished-like', async () => {
  const s = await bootServer();
  s.setLimits({ global: 9, perProject: 9 });
  await ui(s, '/api/agents', 'POST', { slug: 'fix-login', profile: 'developer' });
  await modEvent(s, 'fix-login', 'session.start');
  await modEvent(s, 'fix-login', 'turn.start');
  expect((await req(s, '/api/agents/fix-login/archive', { method: 'POST' })).status).toBe(401);
  expect((await ui(s, '/api/agents/nobody/archive', 'POST')).status).toBe(404);
  expect((await ui(s, '/api/agents/nobody/unarchive', 'POST')).status).toBe(404);
  const busy = await ui(s, '/api/agents/fix-login/archive', 'POST');
  expect(busy.status).toBe(409);
  expect(busy.body.code).toBe('agent.notArchivable');
  // an agent with no ticket at rest is still not finished-like: the by-hand archive is for delivered or merged work
  await modEvent(s, 'fix-login', 'turn.complete');
  expect((await ui(s, '/api/agents/fix-login/archive', 'POST')).status).toBe(409);
  // un-archiving one that is not archived is harmless
  expect((await ui(s, '/api/agents/fix-login/unarchive', 'POST')).status).toBe(200);
});

it('DELETE /api/agents/<slug> needs the token, names a known agent and refuses one that is not archived', async () => {
  const s = await bootServer();
  s.setLimits({ global: 9, perProject: 9 });
  await ui(s, '/api/agents', 'POST', { slug: 'fix-login', profile: 'developer' });
  await modEvent(s, 'fix-login', 'session.start');
  expect((await req(s, '/api/agents/fix-login', { method: 'DELETE' })).status).toBe(401);
  expect((await ui(s, '/api/agents/nobody', 'DELETE')).status).toBe(404);
  const live = await ui(s, '/api/agents/fix-login', 'DELETE');
  expect(live.status).toBe(409);
  expect(live.body.code).toBe('agent.notArchived');
  expect((await req(s, '/api/agents/delete-archived', { method: 'POST' })).status).toBe(401);
  expect((await ui(s, '/api/agents/delete-archived', 'POST')).body).toEqual({ count: 0, slugs: [] });
});

it('the state carries no archived flag for an agent at work', async () => {
  const s = await bootServer();
  s.setLimits({ global: 9, perProject: 9 });
  await ui(s, '/api/agents', 'POST', { slug: 'fix-login', profile: 'developer' });
  await modEvent(s, 'fix-login', 'session.start');
  const st = (await ui(s, '/api/state')).body;
  expect(st.agents[0].archived).toBeUndefined();
});

it('POST /api/agents/archive-finished needs the token and archives what can be archived, returning count and slugs', async () => {
  const s = await bootServer();
  s.setLimits({ global: 9, perProject: 9 });
  await ui(s, '/api/agents', 'POST', { slug: 'fix-login', profile: 'developer' });
  await modEvent(s, 'fix-login', 'session.start');
  await modEvent(s, 'fix-login', 'turn.start');
  expect((await req(s, '/api/agents/archive-finished', { method: 'POST' })).status).toBe(401);
  const none = await ui(s, '/api/agents/archive-finished', 'POST');
  expect(none.status).toBe(200);
  expect(none.body).toEqual({ count: 0, slugs: [] });
});
