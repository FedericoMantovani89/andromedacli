// Behaviour of the console mod, run against a fake `$` (the engine API). The real engine is covered by
// test/e2e/mod-real-claude.ts; here we pin the failure paths the real run does not exercise.
import { it, expect, vi } from 'vitest';

type Hook = (...args: any[]) => Promise<any>;
interface Registered { event: string; matcher?: { tool?: string }; hook: Hook }

async function loadMod() {
  vi.resetModules(); // the mod keeps module-level state, like it does in a real process
  const mod = await import('../mod/hooks/register.js');
  const registered: Registered[] = [];
  mod.register((event: string, a: unknown, b?: unknown) => {
    registered.push(b === undefined ? { event, hook: a as Hook } : { event, matcher: a as { tool?: string }, hook: b as Hook });
  });
  const find = (event: string, tool?: string) => registered.find((r) => r.event === event && r.matcher?.tool === tool)!.hook;
  return { find };
}

interface FakeOptions {
  env?: Record<string, string | undefined>;
  fetch?: (url: string, init: { method?: string; body?: string }) => { ok: boolean; status?: number; text?: string } | Error;
}
function fake$(o: FakeOptions = {}) {
  const env = { CONSOLE_URL: 'http://127.0.0.1:1', CONSOLE_TOKEN: 'T', CONSOLE_ROLE: 'main', CONSOLE_AGENT: 'shop-api', ...o.env };
  const calls: string[] = [];
  const ticks: (() => Promise<void> | void)[] = [];
  const registeredTools: string[] = [];
  const submitted: string[] = [];
  const $ = {
    env: { get: async (name: string) => env[name as keyof typeof env] },
    session: { id: async () => 'sid-1' },
    http: {
      fetch: async (url: string, init: { method?: string; body?: string } = {}) => {
        calls.push(`${init.method ?? 'GET'} ${url.replace('http://127.0.0.1:1', '')}`);
        const r = o.fetch ? o.fetch(url, init) : { ok: true, status: 200, text: '{}' };
        if (r instanceof Error) throw r;
        return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), text: r.text ?? '{}' };
      },
    },
    tool: { register: async (spec: { name: string }) => { registeredTools.push(spec.name); } },
    clock: { every: (_ms: number, fn: () => Promise<void> | void) => { ticks.push(fn); }, sleep: async () => {} },
    prompt: { submit: async ({ text }: { text: string }) => { submitted.push(text); } },
  };
  return { $, calls, ticks, registeredTools, submitted };
}
const next = vi.fn(async (e: unknown) => ({ next: e }));

it('does nothing when it was not launched by the console (no URL or token): no calls, no tools, session untouched', async () => {
  const { find } = await loadMod();
  const f = fake$({ env: { CONSOLE_URL: undefined, CONSOLE_TOKEN: undefined } });
  const out = await find('session.start')(f.$, { cwd: '/x' }, next);
  expect(out).toEqual({ next: { cwd: '/x' } });
  expect(f.calls).toEqual([]);
  expect(f.registeredTools).toEqual([]);
  expect(f.ticks).toEqual([]);
});
it('registers the tools of its role once and starts one inbox poller, even if session.start fires twice', async () => {
  const { find } = await loadMod();
  const f = fake$();
  await find('session.start')(f.$, {}, next);
  await find('session.start')(f.$, {}, next);
  expect(f.registeredTools).toEqual(['spawn_agent', 'list_agents', 'ask_user']);
  expect(f.ticks).toHaveLength(1);
});
it('an agent gets only list_agents', async () => {
  const { find } = await loadMod();
  const f = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' } });
  await find('session.start')(f.$, {}, next);
  expect(f.registeredTools).toEqual(['list_agents']);
});
it('delivers an inbox message only after the console confirmed receiving it', async () => {
  const { find } = await loadMod();
  const f = fake$({ fetch: (url) => url.endsWith('/v1/inbox') ? { ok: true, text: JSON.stringify({ messages: [{ id: 'm1', text: 'hello goal' }] }) } : { ok: true, text: '{}' } });
  await find('session.start')(f.$, {}, next);
  await f.ticks[0]!();
  expect(f.calls.indexOf('POST /v1/ack')).toBeGreaterThan(f.calls.indexOf('GET /v1/inbox'));
  expect(f.submitted).toEqual(['hello goal']);
});
it('does not inject a message when the acknowledgement failed (it would be delivered twice)', async () => {
  const { find } = await loadMod();
  const f = fake$({ fetch: (url) => url.endsWith('/v1/inbox') ? { ok: true, text: JSON.stringify({ messages: [{ id: 'm1', text: 'goal' }] }) } : url.endsWith('/v1/ack') ? { ok: false, status: 500 } : { ok: true } });
  await find('session.start')(f.$, {}, next);
  await f.ticks[0]!();
  expect(f.submitted).toEqual([]);
});
it('a console that cannot be reached never breaks a hook: it still passes the event on', async () => {
  const { find } = await loadMod();
  const f = fake$({ fetch: () => new Error('ECONNREFUSED') });
  await find('session.start')(f.$, {}, next);
  const e = { turnId: 't1', answer: 'x' };
  expect(await find('turn.complete')(f.$, e, next)).toEqual({ next: e });
  expect(await find('turn.start')(f.$, {}, next)).toEqual({ next: {} });
});
it('turn.complete forwards the final answer', async () => {
  const { find } = await loadMod();
  const f = fake$();
  await find('session.start')(f.$, {}, next);
  let body = '';
  const g = fake$({ fetch: (_u, init) => { if (init.body) body = init.body; return { ok: true, text: '{}' }; } });
  await find('turn.complete')(g.$, { turnId: 't1', answer: 'the answer', isAborted: false, durationMs: 5 }, next);
  expect(JSON.parse(body)).toMatchObject({ type: 'turn.complete', sessionId: 'sid-1', data: { answer: 'the answer', turn: 't1' } });
});
it('ask_user waits through repeated polls and returns the human answer', async () => {
  const { find } = await loadMod();
  let polls = 0;
  const f = fake$({ fetch: (url, init) => {
    if (init.method === 'POST' && url.endsWith('/v1/tools/ask_user')) return { ok: true, text: JSON.stringify({ id: 'q1' }) };
    if (url.includes('/v1/questions/q1')) { polls += 1; return { ok: true, text: JSON.stringify(polls < 3 ? { answered: false } : { answered: true, answer: 'Red' }) }; }
    return { ok: true, text: '{}' };
  } });
  await find('session.start')(f.$, {}, next);
  const out = await find('tool.call', 'mcp__console-mod__ask_user')(f.$, { question: 'Color?', options: ['Red', 'Blue'] });
  expect(out).toEqual({ result: 'The user answered: Red' });
  expect(polls).toBe(3);
});
it('ask_user gives up with a clear message when the console stops answering, instead of hanging', async () => {
  const { find } = await loadMod();
  let created = false;
  const f = fake$({ fetch: (url, init) => {
    if (init.method === 'POST' && url.endsWith('/v1/tools/ask_user')) { created = true; return { ok: true, text: JSON.stringify({ id: 'q1' }) }; }
    return new Error('down');
  } });
  await find('session.start')(f.$, {}, next);
  const out = await find('tool.call', 'mcp__console-mod__ask_user')(f.$, { question: 'Color?' });
  expect(created).toBe(true);
  expect(out.result).toMatch(/No answer/);
});
it('an agent native AskUserQuestion goes to the console; if the console is unreachable the normal dialog is left alone', async () => {
  const { find } = await loadMod();
  const f = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: () => new Error('down') });
  await find('session.start')(f.$, {}, next);
  const e = { questions: [{ question: 'Fruit?', options: [{ label: 'Apple' }, { label: 'Pear' }] }] };
  expect(await find('tool.call', 'AskUserQuestion')(f.$, e, next)).toEqual({ next: e });
  const answering = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: (url, init) => {
    if (init.method === 'POST' && url.endsWith('/v1/tools/ask_user')) return { ok: true, text: JSON.stringify({ id: 'q9' }) };
    if (url.includes('/v1/questions/q9')) return { ok: true, text: JSON.stringify({ answered: true, answer: 'Pear' }) };
    return { ok: true, text: '{}' };
  } });
  await find('session.start')(answering.$, {}, next);
  expect(await find('tool.call', 'AskUserQuestion')(answering.$, e, next)).toEqual({ result: { questions: e.questions, answers: { 'Fruit?': 'Pear' } } });
});

// ---- permission routing (tool.check) ----
const bashCheck = { tool: 'Bash', input: { command: 'echo hi > out.txt' }, tool_use_id: 'tu1' };
const asking = async () => ({ decision: 'ask', reason: 'Bash needs approval' });
const permissionFetch = (answer: string) => (url: string, init: { method?: string; body?: string }) => {
  if (init.method === 'POST' && url.endsWith('/v1/tools/ask_user')) return { ok: true, text: JSON.stringify({ id: 'p1' }) };
  if (url.includes('/v1/questions/p1')) return { ok: true, text: JSON.stringify({ answered: true, answer }) };
  return { ok: true, text: '{}' };
};

it('an agent permission prompt goes to the console queue as a permission, with the tool and what it would do', async () => {
  const { find } = await loadMod();
  const posted: any[] = [];
  const f = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: (url, init) => {
    if (init.method === 'POST' && url.endsWith('/v1/tools/ask_user')) { posted.push(JSON.parse(init.body!)); return { ok: true, text: JSON.stringify({ id: 'p1' }) }; }
    return permissionFetch('allow')(url, init);
  } });
  await find('session.start')(f.$, {}, next);
  const out = await find('tool.check')(f.$, bashCheck, asking);
  expect(out.decision).toBe('allow');
  expect(posted[0]).toMatchObject({ kind: 'permission', tool: 'Bash', detail: 'echo hi > out.txt' });
});
it('"deny" from the console refuses the tool with a reason the model reads', async () => {
  const { find } = await loadMod();
  const f = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: permissionFetch('deny') });
  await find('session.start')(f.$, {}, next);
  const out = await find('tool.check')(f.$, bashCheck, asking);
  expect(out.decision).toBe('deny');
  expect(out.reason).toMatch(/denied/i);
});
it('anything but an explicit allow is a deny (never allows by accident)', async () => {
  const { find } = await loadMod();
  const f = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: permissionFetch('maybe') });
  await find('session.start')(f.$, {}, next);
  expect((await find('tool.check')(f.$, bashCheck, asking)).decision).toBe('deny');
});
it('leaves alone: an engine "allow" or "deny", the main session, queries without a call id, and the console\'s own tools', async () => {
  const { find } = await loadMod();
  const agent = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: permissionFetch('allow') });
  await find('session.start')(agent.$, {}, next);
  const before = agent.calls.length;
  expect((await find('tool.check')(agent.$, bashCheck, async () => ({ decision: 'allow' }))).decision).toBe('allow');
  expect((await find('tool.check')(agent.$, bashCheck, async () => ({ decision: 'deny', reason: 'rule' }))).decision).toBe('deny');
  expect((await find('tool.check')(agent.$, { tool: 'Bash', input: {} }, asking)).decision).toBe('ask');
  expect((await find('tool.check')(agent.$, { tool: 'AskUserQuestion', input: {}, tool_use_id: 'x' }, asking)).decision).toBe('ask');
  expect((await find('tool.check')(agent.$, { tool: 'mcp__console-mod__list_agents', input: {}, tool_use_id: 'x' }, asking)).decision).toBe('ask');
  expect(agent.calls.length).toBe(before);
  const { find: findMain } = await loadMod();
  const main = fake$({ env: { CONSOLE_ROLE: 'main' }, fetch: permissionFetch('allow') });
  await findMain('session.start')(main.$, {}, next);
  expect((await findMain('tool.check')(main.$, bashCheck, asking)).decision).toBe('ask'); // the user is typing in main: native dialog
});
it('if the console is unreachable the native dialog is left in place (the engine ask stands)', async () => {
  const { find } = await loadMod();
  const f = fake$({ env: { CONSOLE_ROLE: 'agent', CONSOLE_AGENT: 'fix-login' }, fetch: () => new Error('down') });
  await find('session.start')(f.$, {}, next);
  expect((await find('tool.check')(f.$, bashCheck, asking)).decision).toBe('ask');
});
