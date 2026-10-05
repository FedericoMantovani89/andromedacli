import { it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../src/server/index';
import type { Runner } from '../src/server/prereq/checks';

const fixture = join(__dirname, 'fixtures', 'fake-agent.cjs').replace(/\\/g, '/');
type Running = Awaited<ReturnType<typeof startServer>>;
const running: Running[] = [];
afterEach(async () => { while (running.length) await running.pop()!.close(); });

const goodRunner: Runner = async (cmd) => ({
  code: 0, stdout: cmd === 'node' ? 'v24.15.0' : cmd === 'git' ? 'git version 2.53.0' : '2.1.289 (Claude Code)',
});

async function boot(): Promise<Running> {
  const configDir = mkdtempSync(join(tmpdir(), 'v1-cfg-'));
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ schema: 1, language: 'en' }));
  const s = await startServer({
    port: 0, planRoot: mkdtempSync(join(tmpdir(), 'v1-plan-')), configDir, planName: 'shop-api',
    claudeCommand: [process.execPath, fixture], prereqRunner: goodRunner, worktrees: false,
  });
  running.push(s);
  return s;
}

function req(s: Running, path: string, o: { method?: string; token?: string; host?: string; body?: unknown; raw?: string } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: o.host ?? `127.0.0.1:${s.port}` };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    const payload = o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined);
    if (payload !== undefined) headers['content-type'] = 'application/json';
    const r = http.request({ host: '127.0.0.1', port: s.port, path, method: o.method ?? 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { let body: any = data; try { body = JSON.parse(data); } catch { /* not json */ } resolve({ status: res.statusCode ?? 0, body }); });
    });
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

const until = async (f: () => Promise<boolean> | boolean, ms = 8000) => {
  const t = Date.now();
  while (!(await f())) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 30)); }
};
const state = async (s: Running) => (await req(s, '/api/state', { token: s.token })).body;
const ev = (token: string, type: string, data?: unknown) => ({ token, method: 'POST', body: { type, sessionId: 'sess-1', data } });

it('refuses the UI token on /v1, an unknown token, and a foreign Host', async () => {
  const s = await boot();
  expect((await req(s, '/v1/inbox', { token: s.token })).status).toBe(401);
  expect((await req(s, '/v1/inbox', { token: 'nope' })).status).toBe(401);
  expect((await req(s, '/v1/inbox')).status).toBe(401);
  expect((await req(s, '/v1/inbox', { token: s.sessionTokenFor('shop-api'), host: 'evil.example' })).status).toBe(403);
});
it('refuses a session token on the UI API and the UI WebSocket', async () => {
  const s = await boot();
  const t = s.sessionTokenFor('shop-api')!;
  expect((await req(s, '/api/state', { token: t })).status).toBe(401);
  const status = await new Promise<number>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/ui?token=${t}`, { headers: { origin: `http://127.0.0.1:${s.port}` } });
    ws.on('open', () => resolve(101));
    ws.on('unexpected-response', (_r, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => {});
  });
  expect(status).toBe(401);
});
it('mod events move the session through its states, visible in /api/state', async () => {
  const s = await boot();
  const t = s.sessionTokenFor('shop-api')!;
  expect((await state(s)).main.state).toBe('starting');
  expect((await req(s, '/v1/events', ev(t, 'session.start'))).status).toBe(204);
  expect((await state(s)).main.state).toBe('idle');
  await req(s, '/v1/events', ev(t, 'turn.start'));
  expect((await state(s)).main.state).toBe('working');
  await req(s, '/v1/events', ev(t, 'turn.complete', { answer: 'done' }));
  expect((await state(s)).main.state).toBe('idle');
});
it('rejects unknown event types and malformed or oversized bodies', async () => {
  const s = await boot();
  const t = s.sessionTokenFor('shop-api')!;
  expect((await req(s, '/v1/events', ev(t, 'turn.explode'))).status).toBe(400);
  expect((await req(s, '/v1/events', { token: t, method: 'POST', raw: '{not json' })).status).toBe(400);
  expect((await req(s, '/v1/events', { token: t, method: 'POST', raw: JSON.stringify({ type: 'turn.start', sessionId: 'x', pad: 'a'.repeat(3 * 1024 * 1024) }) })).status).toBe(400);
});
it('accepts a quota event with a session token and does not move the session state', async () => {
  const s = await boot();
  const t = s.sessionTokenFor('shop-api')!;
  await req(s, '/v1/events', ev(t, 'session.start'));
  const rateLimits = [{ kind: 'five_hour', percentUsed: 10, resetsAt: '2026-10-05T15:00:00Z' }];
  expect((await req(s, '/v1/events', ev(t, 'quota', { rateLimits }))).status).toBe(204);
  expect((await state(s)).main.state).toBe('idle');
  expect((await req(s, '/v1/events', ev(t, 'quotas'))).status).toBe(400);
});
it('delivers inbox messages until they are acknowledged, and only to their owner', async () => {
  const s = await boot();
  await req(s, '/api/agents', { method: 'POST', token: s.token, body: { slug: 'fix-login', profile: 'backend' } });
  const main = s.sessionTokenFor('shop-api')!, other = s.sessionTokenFor('fix-login')!;
  const id = s.sendMessage('shop-api', 'hello main');
  const first = (await req(s, '/v1/inbox', { token: main })).body.messages;
  expect(first).toEqual([{ id, text: 'hello main' }]);
  expect((await req(s, '/v1/inbox', { token: main })).body.messages).toHaveLength(1); // not acked: redelivered
  expect((await req(s, '/v1/inbox', { token: other })).body.messages).toEqual([]);
  expect((await req(s, '/v1/ack', { token: other, method: 'POST', body: { id } })).status).toBe(404);
  expect((await req(s, '/v1/ack', { token: main, method: 'POST', body: { id } })).status).toBe(204);
  expect((await req(s, '/v1/inbox', { token: main })).body.messages).toEqual([]);
});
it('a session can only act as itself: the agent named in the body is ignored', async () => {
  const s = await boot();
  await req(s, '/api/agents', { method: 'POST', token: s.token, body: { slug: 'fix-login', profile: 'backend' } });
  const main = s.sessionTokenFor('shop-api')!;
  await req(s, '/v1/events', { token: main, method: 'POST', body: { type: 'turn.start', sessionId: 'x', agent: 'fix-login', slug: 'fix-login' } });
  const st = await state(s);
  expect(st.main.state).toBe('working');
  expect(st.agents[0].state).toBe('starting');
});
it('tools are limited by role: an agent cannot call spawn_agent', async () => {
  const s = await boot();
  await req(s, '/api/agents', { method: 'POST', token: s.token, body: { slug: 'fix-login', profile: 'backend' } });
  const r = await req(s, '/v1/tools/spawn_agent', { token: s.sessionTokenFor('fix-login'), method: 'POST', body: { name: 'x-job', profile: 'backend', goal: 'g' } });
  expect(r.status).toBe(403);
  expect((await req(s, '/v1/tools/does_not_exist', { token: s.sessionTokenFor('shop-api'), method: 'POST', body: {} })).status).toBe(404);
});
it('a session token stops working once its process has exited', async () => {
  const s = await boot();
  await req(s, '/api/agents', { method: 'POST', token: s.token, body: { slug: 'fix-login', profile: 'backend' } });
  const t = s.sessionTokenFor('fix-login')!;
  expect((await req(s, '/v1/inbox', { token: t })).status).toBe(200);
  s.writeToSession('fix-login', 'quit\r');
  await until(async () => (await req(s, '/v1/inbox', { token: t })).status === 401);
  expect((await state(s)).agents[0].state).toBe('interrupted');
});

it('accepts a turn.complete with a large final answer (well above the default body limit) and stores it, truncated', async () => {
  const s = await boot();
  const t = s.sessionTokenFor('shop-api')!;
  const answer = 'z'.repeat(300 * 1024);
  expect((await req(s, '/v1/events', ev(t, 'turn.complete', { answer }))).status).toBe(204);
  const entries = (await req(s, '/api/reading/shop-api', { token: s.token })).body.entries;
  expect(entries).toHaveLength(1);
  expect(entries[0].truncated).toBe(true);
  expect(entries[0].text.length).toBeGreaterThan(100 * 1024);
});

it('recovery_report belongs to the recovery role only; start_recovery to the main; a recovery may list agents and ask the user', async () => {
  const { handleV1 } = await import('../src/server/v1');
  const { SessionTokens } = await import('../src/server/security');
  const { AgentRegistry } = await import('../src/server/agents/registry');
  const { Inbox } = await import('../src/server/agents/inbox');
  const { QuestionQueue } = await import('../src/server/questions/queue');
  const tokens = new SessionTokens();
  const registry = new AgentRegistry();
  registry.register({ slug: 'shop-api', role: 'main', profile: 'main' });
  registry.register({ slug: 'fix-login', role: 'agent', profile: 'backend' });
  registry.register({ slug: 'recover-fix-login', role: 'recovery', profile: 'recovery' });
  registry.register({ slug: 'review-fix-login', role: 'reviewer', profile: 'reviewer' });
  const called: string[] = [];
  const handler = (name: string) => async (slug: string) => { called.push(`${name}:${slug}`); return { status: 'ok' }; };
  const ctx = {
    tokens, registry, inbox: new Inbox(), questions: new QuestionQueue(), handleModEvent: () => {}, guard: () => ({ decision: 'allow' as const }),
    tools: { recovery_report: handler('recovery_report'), start_recovery: handler('start_recovery'), list_agents: handler('list_agents'), ask_user: handler('ask_user') },
  };
  const server = http.createServer((rq, rs) => { void handleV1(ctx, rq, rs, new URL(rq.url ?? '/', 'http://127.0.0.1')); });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const port = (server.address() as { port: number }).port;
  const call = (slug: string, tool: string): Promise<number> => new Promise((resolve, reject) => {
    const body = JSON.stringify({});
    const r = http.request({ host: '127.0.0.1', port, path: `/v1/tools/${tool}`, method: 'POST', headers: { authorization: `Bearer ${tokens.issue(slug)}`, 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    r.on('error', reject);
    r.end(body);
  });
  try {
    expect(await call('recover-fix-login', 'recovery_report')).toBe(200);
    for (const slug of ['fix-login', 'shop-api', 'review-fix-login']) expect(await call(slug, 'recovery_report'), slug).toBe(403);
    expect(await call('shop-api', 'start_recovery')).toBe(200);
    for (const slug of ['fix-login', 'recover-fix-login', 'review-fix-login']) expect(await call(slug, 'start_recovery'), slug).toBe(403);
    expect(await call('recover-fix-login', 'list_agents')).toBe(200);
    expect(await call('recover-fix-login', 'ask_user')).toBe(200);
    for (const tool of ['step_done', 'checklist_set', 'spawn_agent', 'review_verdict']) expect(await call('recover-fix-login', tool), tool).toBe(403);
    expect(called).toEqual(['recovery_report:recover-fix-login', 'start_recovery:shop-api', 'list_agents:recover-fix-login', 'ask_user:recover-fix-login']);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

it('resume_agent belongs to the main only: an agent, a reviewer or a recovery calling it gets 403', async () => {
  const { handleV1 } = await import('../src/server/v1');
  const { SessionTokens } = await import('../src/server/security');
  const { AgentRegistry } = await import('../src/server/agents/registry');
  const { Inbox } = await import('../src/server/agents/inbox');
  const { QuestionQueue } = await import('../src/server/questions/queue');
  const tokens = new SessionTokens();
  const registry = new AgentRegistry();
  registry.register({ slug: 'shop-api', role: 'main', profile: 'main' });
  registry.register({ slug: 'fix-login', role: 'agent', profile: 'backend' });
  registry.register({ slug: 'recover-fix-login', role: 'recovery', profile: 'recovery' });
  registry.register({ slug: 'review-fix-login', role: 'reviewer', profile: 'reviewer' });
  const called: unknown[] = [];
  const ctx = {
    tokens, registry, inbox: new Inbox(), questions: new QuestionQueue(), handleModEvent: () => {}, guard: () => ({ decision: 'allow' as const }),
    tools: { resume_agent: async (slug: string, body: unknown) => { called.push({ slug, body }); return { status: 'ok', started: [], scheduled: [] }; } },
  };
  const server = http.createServer((rq, rs) => { void handleV1(ctx, rq, rs, new URL(rq.url ?? '/', 'http://127.0.0.1')); });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const port = (server.address() as { port: number }).port;
  const call = (slug: string): Promise<number> => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/v1/tools/resume_agent', method: 'POST', headers: { authorization: `Bearer ${tokens.issue(slug)}`, 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    r.on('error', reject);
    r.end(JSON.stringify({ names: ['fix-login'] }));
  });
  try {
    for (const slug of ['fix-login', 'recover-fix-login', 'review-fix-login']) expect(await call(slug), slug).toBe(403);
    expect(called).toEqual([]);
    expect(await call('shop-api')).toBe(200);
    expect(called).toEqual([{ slug: 'shop-api', body: { names: ['fix-login'] } }]);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});
