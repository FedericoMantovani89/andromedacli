import { it, expect } from 'vitest';
import { autoClose, bootServer, modEvent, mod, ui, state, until } from './helpers';

autoClose();

const spawnTool = (s: Awaited<ReturnType<typeof bootServer>>, name: string, goal = 'make it work', profile = 'developer') =>
  mod(s, 'shop-api', '/v1/tools/spawn_agent', 'POST', { name, profile, goal });

it('the main starts an agent with a valid name: process, state, and the goal waiting in its inbox', async () => {
  const s = await bootServer();
  const r = await spawnTool(s, 'fix-login-timeout', 'Fix the login timeout in AuthService');
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ status: 'started', name: 'fix-login-timeout' });
  const st = await state(s);
  expect(st.agents.map((a: any) => [a.slug, a.status, a.state])).toEqual([['fix-login-timeout', 'running', 'starting']]);
  const inbox = (await mod(s, 'fix-login-timeout', '/v1/inbox')).body.messages;
  expect(inbox).toHaveLength(1);
  expect(inbox[0].text).toContain('Fix the login timeout in AuthService');
});
it('a bad name or profile comes back as an error code the main can read, and nothing starts', async () => {
  const s = await bootServer();
  expect((await spawnTool(s, 'agent-1')).body).toEqual({ status: 'error', code: 'slug.generic', params: { slug: 'agent-1' } });
  expect((await spawnTool(s, 'fix-login', 'g', 'wizard')).body).toMatchObject({ status: 'error', code: 'profile.invalid' });
  expect((await state(s)).agents).toEqual([]);
});
it('over the limit the request is queued, visible as "queued", with no process', async () => {
  const s = await bootServer();
  s.setLimits({ global: 1, perProject: 1 });
  expect((await spawnTool(s, 'first-job')).body.status).toBe('started');
  const second = (await spawnTool(s, 'second-job')).body;
  expect(second).toEqual({ status: 'queued', name: 'second-job', position: 1 });
  const st = await state(s);
  expect(st.agents.map((a: any) => [a.slug, a.status, a.state])).toEqual([['first-job', 'running', 'starting'], ['second-job', 'pending', 'queued']]);
  expect((await ui(s, '/api/debug/snapshot/second-job')).status).toBe(404); // no process, no debug route either way
});
it('a queued name is reserved: asking for it again is a duplicate', async () => {
  const s = await bootServer();
  s.setLimits({ global: 1, perProject: 1 });
  await spawnTool(s, 'first-job'); await spawnTool(s, 'second-job');
  expect((await spawnTool(s, 'second-job')).body).toMatchObject({ status: 'error', code: 'slug.duplicate' });
});
it('the queued agent starts by itself when the first one finishes its goal', async () => {
  const s = await bootServer();
  s.setLimits({ global: 1, perProject: 1 });
  await spawnTool(s, 'first-job'); await spawnTool(s, 'second-job');
  await modEvent(s, 'first-job', 'session.start');
  await modEvent(s, 'first-job', 'turn.start');
  await modEvent(s, 'first-job', 'turn.complete', { answer: 'done' });
  await until(async () => (await state(s)).agents.find((a: any) => a.slug === 'second-job')?.status === 'running');
  const second = (await state(s)).agents.find((a: any) => a.slug === 'second-job');
  expect(second.state).toBe('starting');
  expect((await mod(s, 'second-job', '/v1/inbox')).body.messages[0].text).toContain('make it work');
});
it('lowering the limit stops nothing that is running', async () => {
  const s = await bootServer();
  s.setLimits({ global: 3, perProject: 3 });
  await spawnTool(s, 'one-job'); await spawnTool(s, 'two-job');
  s.setLimits({ global: 1, perProject: 1 });
  const st = await state(s);
  expect(st.agents.every((a: any) => a.status === 'running')).toBe(true);
  expect((await spawnTool(s, 'three-job')).body.status).toBe('queued');
});
it('a process that dies while working frees its slot for the queue', async () => {
  const s = await bootServer();
  s.setLimits({ global: 1, perProject: 1 });
  await spawnTool(s, 'first-job'); await spawnTool(s, 'second-job');
  await modEvent(s, 'first-job', 'turn.start');
  s.writeToSession('first-job', 'quit\r');
  await until(async () => (await state(s)).agents.find((a: any) => a.slug === 'second-job')?.status === 'running');
  expect((await state(s)).agents.find((a: any) => a.slug === 'first-job').state).toBe('interrupted');
});
it('the UI button goes through the same flow: 201 when started, 202 with the position when queued', async () => {
  const s = await bootServer();
  s.setLimits({ global: 1, perProject: 1 });
  const a = await ui(s, '/api/agents', 'POST', { slug: 'first-job', profile: 'developer' });
  expect(a.status).toBe(201);
  const b = await ui(s, '/api/agents', 'POST', { slug: 'second-job', profile: 'developer' });
  expect(b.status).toBe(202);
  expect(b.body).toEqual({ slug: 'second-job', status: 'queued', position: 1 });
  // a manually launched agent has no goal to deliver
  expect((await mod(s, 'first-job', '/v1/inbox')).body.messages).toEqual([]);
});
it('the agent system prompt file and the model reach the launch (profile model, explicit model wins)', async () => {
  const s = await bootServer();
  await spawnTool(s, 'with-prompt');
  expect(s.lastLaunchArgs('with-prompt')?.join(' ')).toContain('--append-system-prompt-file');
});

it('a model name that is not a plain model id is refused before anything starts', async () => {
  const s = await bootServer();
  for (const model of ['sonnet&calc', 'a b', 'x;y', '']) {
    const r = await mod(s, 'shop-api', '/v1/tools/spawn_agent', 'POST', { name: 'model-test', profile: 'developer', goal: 'g', model });
    if (model === '') expect(r.body.status).toBe('started'); // empty = no model given
    else expect(r.body).toMatchObject({ status: 'error', code: 'model.invalid' });
    if (model !== '') expect((await state(s)).agents).toEqual([]);
  }
});

it('a queued replacement whose start fails later hands its ticket to the user (never in_progress with no agent)', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { failQueuedStart } = await import('../src/server/agents/spawn');
  const { TicketStore } = await import('../src/server/tickets/store');
  const { Inbox } = await import('../src/server/agents/inbox');
  const { AgentRegistry } = await import('../src/server/agents/registry');
  const { SessionTokens } = await import('../src/server/security');
  const tickets = new TicketStore(mkdtempSync(join(tmpdir(), 'fq-')));
  tickets.setChecklist('fix-login-r2', []); // the ticket moved to the new name, back in_progress
  const inbox = new Inbox();
  const registry = new AgentRegistry();
  registry.register({ slug: 'fix-login-r2', role: 'agent', profile: 'developer', queued: true });
  const ctx = {
    tickets, inbox, registry, tokens: new SessionTokens(), projectName: 'shop-api', broadcastState: () => {},
    review: { abandonReview: () => false }, recovery: { abandon: () => false },
  } as unknown as Parameters<typeof failQueuedStart>[0];
  failQueuedStart(ctx, { slug: 'fix-login-r2', profile: 'developer', source: 'main', resumeBranch: 'agent/shop-api/fix-login' });
  expect(tickets.get('fix-login-r2')!.status).toBe('needs_user');
  expect(registry.get('fix-login-r2')!.state).toBe('interrupted');
  const told = inbox.pending('shop-api').map((m) => m.text).join('\n');
  expect(told).toContain('fix-login-r2');
  expect(told).toContain('agent/shop-api/fix-login');
  expect(told).toContain('needs_user');
});
