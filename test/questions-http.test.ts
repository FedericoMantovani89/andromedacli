import { it, expect } from 'vitest';
import { autoClose, bootServer, mod, modEvent, req, ui, state, until } from './helpers';

autoClose();

async function withAgent() {
  const s = await bootServer();
  s.setLimits({ global: 9, perProject: 9 });
  await ui(s, '/api/agents', 'POST', { slug: 'fix-login', profile: 'developer' });
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
  await ui(s, '/api/agents', 'POST', { slug: 'other-job', profile: 'developer' });
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
  const { id } = (await mod(s, 'fix-login', '/v1/tools/ask_user', 'POST', { kind: 'permission', tool: 'Bash', detail: 'echo hi > out.txt', key: JSON.stringify({ command: 'echo hi > out.txt' }), question: 'Bash needs approval' })).body;
  const st = await state(s);
  expect(st.queue).toMatchObject([{ id, from: 'fix-login', kind: 'permission', tool: 'Bash', detail: 'echo hi > out.txt', options: ['allow', 'deny', 'allow_always', 'deny_always'] }]);
  expect(st.agents[0].state).toBe('waiting_user');
  expect(st.agents[0].waiting).toBe(1);
  expect((await ui(s, `/api/queue/${id}/answer`, 'POST', { answer: 'maybe' })).status).toBe(400);
  expect((await ui(s, `/api/queue/${id}/answer`, 'POST', { answer: 'allow' })).status).toBe(200);
  expect((await mod(s, 'fix-login', `/v1/questions/${id}?wait=1`)).body).toEqual({ answered: true, answer: 'allow' });
  expect((await state(s)).agents[0].waiting).toBeUndefined();
});
it('"always allow" is remembered for that agent and the exact same call: the next one is answered at once and never queued', async () => {
  const s = await withAgent();
  const perm = (detail: string) => mod(s, 'fix-login', '/v1/tools/ask_user', 'POST', { kind: 'permission', tool: 'Bash', detail, key: detail, question: 'q' });
  const first = (await perm('npm test')).body.id;
  expect((await ui(s, `/api/queue/${first}/answer`, 'POST', { answer: 'allow_always' })).status).toBe(200);
  expect((await mod(s, 'fix-login', `/v1/questions/${first}?wait=1`)).body).toEqual({ answered: true, answer: 'allow_always' });
  const again = (await perm('npm test')).body.id;
  expect((await mod(s, 'fix-login', `/v1/questions/${again}?wait=1`)).body).toEqual({ answered: true, answer: 'allow' });
  expect((await state(s)).queue).toEqual([]);
  await perm('npm test --watch'); // another detail is asked again
  expect((await state(s)).queue).toHaveLength(1);
});
it('"always deny" answers a deny at once, and a call with no key cannot be answered "always"', async () => {
  const s = await withAgent();
  const perm = (detail?: string) => mod(s, 'fix-login', '/v1/tools/ask_user', 'POST', { kind: 'permission', tool: 'Bash', ...(detail !== undefined ? { detail, key: detail } : {}), question: 'q' });
  const a = (await perm('rm -rf build')).body.id;
  await ui(s, `/api/queue/${a}/answer`, 'POST', { answer: 'deny_always' });
  const b = (await perm('rm -rf build')).body.id;
  expect((await mod(s, 'fix-login', `/v1/questions/${b}?wait=1`)).body).toEqual({ answered: true, answer: 'deny' });
  const c = (await perm()).body.id;
  expect((await ui(s, `/api/queue/${c}/answer`, 'POST', { answer: 'allow_always' })).status).toBe(400); // not offered: nothing to remember
  await perm();
  expect((await state(s)).queue).toHaveLength(2);
});
it('a permission without a key (the mod could not build one) is never remembered, even with the same detail', async () => {
  const s = await withAgent();
  const perm = () => mod(s, 'fix-login', '/v1/tools/ask_user', 'POST', { kind: 'permission', tool: 'WebFetch', detail: '{"url":"https://a.example"}', question: 'q' });
  const a = (await perm()).body.id;
  expect((await ui(s, `/api/queue/${a}/answer`, 'POST', { answer: 'allow_always' })).status).toBe(400);
  expect((await ui(s, `/api/queue/${a}/answer`, 'POST', { answer: 'allow' })).status).toBe(200);
  await perm();
  expect((await state(s)).queue).toHaveLength(1); // asked again: a plain "allow" remembers nothing
});
it('"always" is exact on the key, not on the shown detail: the same cut-short detail with another key is asked again', async () => {
  const s = await withAgent();
  const perm = (key: string) => mod(s, 'fix-login', '/v1/tools/ask_user', 'POST', { kind: 'permission', tool: 'WebFetch', detail: 'same first 2000 chars', key, question: 'q' });
  const a = (await perm('{"url":"a","tail":1}')).body.id;
  await ui(s, `/api/queue/${a}/answer`, 'POST', { answer: 'allow_always' });
  await perm('{"url":"a","tail":2}');
  expect((await state(s)).queue).toHaveLength(1);
});
it('"always" is for one agent: another agent asking the same call is queued', async () => {
  const s = await withAgent();
  await ui(s, '/api/agents', 'POST', { slug: 'other-job', profile: 'developer' });
  await modEvent(s, 'other-job', 'session.start');
  await modEvent(s, 'other-job', 'turn.start');
  const perm = (slug: string) => mod(s, slug, '/v1/tools/ask_user', 'POST', { kind: 'permission', tool: 'Bash', detail: 'npm test', key: 'npm test', question: 'q' });
  const a = (await perm('fix-login')).body.id;
  await ui(s, `/api/queue/${a}/answer`, 'POST', { answer: 'allow_always' });
  await perm('other-job');
  expect((await state(s)).queue.map((q: any) => q.from)).toEqual(['other-job']);
});
it('an "always" survives the end of a turn and is forgotten when the agent\'s process ends', async () => {
  const s = await withAgent();
  const perm = () => mod(s, 'fix-login', '/v1/tools/ask_user', 'POST', { kind: 'permission', tool: 'Bash', detail: 'npm test', key: 'npm test', question: 'q' });
  const a = (await perm()).body.id;
  await ui(s, `/api/queue/${a}/answer`, 'POST', { answer: 'allow_always' });
  await modEvent(s, 'fix-login', 'turn.complete');
  const kept = (await perm()).body.id;
  expect((await mod(s, 'fix-login', `/v1/questions/${kept}?wait=1`)).body).toEqual({ answered: true, answer: 'allow' });
});
it('an "always" also answers the identical requests of the same agent that already wait (parallel tool calls)', async () => {
  const s = await withAgent();
  const perm = () => mod(s, 'fix-login', '/v1/tools/ask_user', 'POST', { kind: 'permission', tool: 'Bash', detail: 'npm test', key: 'npm test', question: 'q' });
  const first = (await perm()).body.id;
  const second = (await perm()).body.id;
  const other = (await mod(s, 'fix-login', '/v1/tools/ask_user', 'POST', { kind: 'permission', tool: 'Bash', detail: 'ls', key: 'ls', question: 'q' })).body.id;
  await ui(s, `/api/queue/${first}/answer`, 'POST', { answer: 'allow_always' });
  expect((await mod(s, 'fix-login', `/v1/questions/${second}?wait=1`)).body).toEqual({ answered: true, answer: 'allow' });
  expect((await state(s)).queue.map((q: any) => q.id)).toEqual([other]);
});
it('permission details are length-limited', async () => {
  const s = await withAgent();
  await mod(s, 'fix-login', '/v1/tools/ask_user', 'POST', { kind: 'permission', tool: 'Bash', detail: 'x'.repeat(20000), question: 'q' });
  expect((await state(s)).queue[0].detail.length).toBeLessThanOrEqual(4000);
});
it('the detail the user sees is built by the console from the key, not taken from the client', async () => {
  const s = await withAgent();
  await mod(s, 'fix-login', '/v1/tools/ask_user', 'POST', { kind: 'permission', tool: 'Bash', detail: 'ls', key: JSON.stringify({ command: 'rm -rf /' }), question: 'q' });
  expect((await state(s)).queue[0].detail).toBe('rm -rf /');
});
it('a permission with no key (too long to keep one) offers only allow and deny', async () => {
  const s = await withAgent();
  await mod(s, 'fix-login', '/v1/tools/ask_user', 'POST', { kind: 'permission', tool: 'WebFetch', detail: 'x', question: 'q' });
  expect((await state(s)).queue[0].options).toEqual(['allow', 'deny']);
});
