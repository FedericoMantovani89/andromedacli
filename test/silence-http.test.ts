import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { autoClose, bootServer, mod, modEvent, ui, until } from './helpers';

autoClose();
afterEach(() => { vi.useRealTimers(); });

const MIN = 60_000;

/** A running server whose agent `fix-login` works; only Date is faked, so sockets and timers stay real. */
async function rig(tickMs?: number) {
  vi.useFakeTimers({ toFake: ['Date'] });
  const s = await bootServer({ tickMs, config: { budget: { loop: { silenceMinutes: 1 } } } });
  s.setLimits({ global: 9, perProject: 9 });
  await ui(s, '/api/agents', 'POST', { slug: 'fix-login', profile: 'developer' });
  await modEvent(s, 'fix-login', 'session.start');
  const states: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/ui?token=${s.token}`, { headers: { origin: `http://127.0.0.1:${s.port}` } });
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'state') states.push(m); });
  await new Promise<void>((ok) => ws.on('open', () => ok()));
  const agentOf = (m: any) => m.agents.find((a: any) => a.slug === 'fix-login');
  return { s, states, agentOf, close: () => ws.close() };
}

it('an agent that wakes up after a long idle never shows the silence chip in the state pushed at that moment', async () => {
  const r = await rig();
  vi.setSystemTime(Date.now() + 20 * MIN);
  r.states.length = 0;
  await modEvent(r.s, 'fix-login', 'turn.start');
  await until(() => r.states.some((m) => r.agentOf(m)?.state === 'working'));
  const first = r.states.find((m) => r.agentOf(m)?.state === 'working');
  expect(r.agentOf(first).silentMinutes).toBeUndefined();
  r.close();
});
it('the answer to a question that waited for minutes does not show the agent as silent', async () => {
  const r = await rig();
  await modEvent(r.s, 'fix-login', 'turn.start');
  const { id } = (await mod(r.s, 'fix-login', '/v1/tools/ask_user', 'POST', { question: 'Which color?', options: ['Red'] })).body;
  vi.setSystemTime(Date.now() + 10 * MIN);
  r.states.length = 0;
  await ui(r.s, `/api/queue/${id}/answer`, 'POST', { answer: 'Red' });
  await until(() => r.states.some((m) => r.agentOf(m)?.state === 'working'));
  const first = r.states.find((m) => r.agentOf(m)?.state === 'working');
  expect(r.agentOf(first).silentMinutes).toBeUndefined();
  r.close();
});
it('the silence chip is pushed by the timer without any other change, and cleared by the next sign of life', async () => {
  const r = await rig(50);
  await modEvent(r.s, 'fix-login', 'turn.start');
  r.states.length = 0;
  vi.setSystemTime(Date.now() + 3 * MIN);
  await until(() => r.states.some((m) => r.agentOf(m)?.silentMinutes === 3));
  r.states.length = 0;
  await mod(r.s, 'fix-login', '/v1/guard', 'POST', { tool: 'Read', input: { file_path: 'a.txt' } }); // a guard question is a sign of life
  await until(() => r.states.some((m) => r.agentOf(m) && r.agentOf(m).silentMinutes === undefined));
  r.close();
});
