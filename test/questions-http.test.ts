import { it, expect } from 'vitest';
import { autoClose, bootServer, mod, modEvent, req, ui, state, until } from './helpers';

autoClose();

async function withAgent() {
  const s = await bootServer();
  s.setLimits({ global: 9, perProject: 9 });
  await ui(s, '/api/agents', 'POST', { slug: 'fix-login', profile: 'backend' });
  await modEvent(s, 'fix-login', 'session.start');
  await modEvent(s, 'fix-login', 'turn.start');
  return s;
}
const ask = (s: Awaited<ReturnType<typeof bootServer>>, slug = 'fix-login') =>
  mod(s, slug, '/v1/tools/ask_user', 'POST', { question: 'Which color?', options: ['Red', 'Blue'] });

it('a question goes to the queue, the agent shows waiting_user, the answer reaches the long-poll and it works again', async () => {
  const s = await withAgent();
  const { id } = (await ask(s)).body;
  expect(id).toBeTruthy();
  let st = await state(s);
  expect(st.queue).toMatchObject([{ id, from: 'fix-login', text: 'Which color?', options: ['Red', 'Blue'] }]);
  expect(st.agents[0].state).toBe('waiting_user');
  expect((await mod(s, 'fix-login', `/v1/questions/${id}?wait=1`)).body).toEqual({ answered: false });
  expect((await ui(s, `/api/queue/${id}/answer`, 'POST', { answer: 'Red' })).status).toBe(200);
  expect((await mod(s, 'fix-login', `/v1/questions/${id}?wait=1`)).body).toEqual({ answered: true, answer: 'Red' });
  st = await state(s);
  expect(st.queue).toEqual([]);
  expect(st.agents[0].state).toBe('working');
});
it('a long-poll in flight is released as soon as the user answers', async () => {
  const s = await withAgent();
  const { id } = (await ask(s)).body;
  const t0 = Date.now();
  const polling = mod(s, 'fix-login', `/v1/questions/${id}?wait=15`);
  setTimeout(() => { void ui(s, `/api/queue/${id}/answer`, 'POST', { answer: 'Blue' }); }, 200);
  expect((await polling).body).toEqual({ answered: true, answer: 'Blue' });
  expect(Date.now() - t0).toBeLessThan(3000);
});
it("answers need the UI token; another session cannot read someone else's question", async () => {
  const s = await withAgent();
  await ui(s, '/api/agents', 'POST', { slug: 'other-job', profile: 'backend' });
  const { id } = (await ask(s)).body;
  expect((await mod(s, 'fix-login', `/api/queue/${id}/answer`, 'POST', { answer: 'x' })).status).toBe(401);
  expect((await mod(s, 'other-job', `/v1/questions/${id}?wait=1`)).body).toEqual({ answered: false, gone: true });
  expect((await state(s)).queue).toHaveLength(1);
});
it('answering twice gives 409, an unknown id 404, an empty answer 400', async () => {
  const s = await withAgent();
  const { id } = (await ask(s)).body;
  expect((await ui(s, `/api/queue/${id}/answer`, 'POST', { answer: '  ' })).status).toBe(400);
  expect((await ui(s, `/api/queue/${id}/answer`, 'POST', { answer: 'Red' })).status).toBe(200);
  expect((await ui(s, `/api/queue/${id}/answer`, 'POST', { answer: 'Blue' })).status).toBe(409);
  expect((await ui(s, '/api/queue/nope/answer', 'POST', { answer: 'x' })).status).toBe(404);
});
it('when the asking process dies its question leaves the queue', async () => {
  const s = await withAgent();
  await ask(s);
  expect((await state(s)).queue).toHaveLength(1);
  s.writeToSession('fix-login', 'quit\r');
  await until(async () => (await state(s)).queue.length === 0);
  expect((await state(s)).agents[0].state).toBe('interrupted');
});
it('the main can ask too, and shows waiting_user meanwhile', async () => {
  const s = await bootServer();
  const { id } = (await mod(s, 'shop-api', '/v1/tools/ask_user', 'POST', { question: 'Existing table or new?' })).body;
  expect((await state(s)).main.state).toBe('waiting_user');
  await ui(s, `/api/queue/${id}/answer`, 'POST', { answer: 'New' });
  expect((await state(s)).main.state).toBe('working');
});
it('a malformed question is refused', async () => {
  const s = await withAgent();
  expect((await mod(s, 'fix-login', '/v1/tools/ask_user', 'POST', { question: '' })).body).toMatchObject({ status: 'error', code: 'bad_request' });
  expect((await state(s)).queue).toEqual([]);
});
it('the queue endpoint is not reachable without the UI token', async () => {
  const s = await withAgent();
  expect((await req(s, '/api/queue/x/answer', { method: 'POST', body: { answer: 'x' } })).status).toBe(401);
});

it('an aborted turn withdraws the question: the turn completes, the queue empties, the agent is idle (not working)', async () => {
  const s = await withAgent();
  await ask(s);
  expect((await state(s)).agents[0].state).toBe('waiting_user');
  await modEvent(s, 'fix-login', 'turn.complete', { isAborted: true });
  const st = await state(s);
  expect(st.queue).toEqual([]);
  expect(st.agents[0].state).toBe('idle');
});

it('a permission request from an agent is queued as a permission, shows the agent waiting, and "allow" reaches the long-poll', async () => {
  const s = await withAgent();
  const { id } = (await mod(s, 'fix-login', '/v1/tools/ask_user', 'POST', { kind: 'permission', tool: 'Bash', detail: 'echo hi > out.txt', question: 'Bash needs approval' })).body;
  const st = await state(s);
  expect(st.queue).toMatchObject([{ id, from: 'fix-login', kind: 'permission', tool: 'Bash', detail: 'echo hi > out.txt', options: ['allow', 'deny'] }]);
  expect(st.agents[0].state).toBe('waiting_user');
  expect((await ui(s, `/api/queue/${id}/answer`, 'POST', { answer: 'maybe' })).status).toBe(400);
  expect((await ui(s, `/api/queue/${id}/answer`, 'POST', { answer: 'allow' })).status).toBe(200);
  expect((await mod(s, 'fix-login', `/v1/questions/${id}?wait=1`)).body).toEqual({ answered: true, answer: 'allow' });
});
it('permission details are length-limited', async () => {
  const s = await withAgent();
  await mod(s, 'fix-login', '/v1/tools/ask_user', 'POST', { kind: 'permission', tool: 'Bash', detail: 'x'.repeat(20000), question: 'q' });
  expect((await state(s)).queue[0].detail.length).toBeLessThanOrEqual(4000);
});
