import { expect, it } from 'vitest';
import WebSocket from 'ws';
import { autoClose, usePipePty, bootServer, modEvent, state, ui, until } from './helpers';

autoClose();
usePipePty(); // this file never reads the terminal: its sessions run on plain pipes

function openUi(s: Awaited<ReturnType<typeof bootServer>>): Promise<{ ws: WebSocket; texts: string[] }> {
  const texts: string[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/ui?token=${s.token}`, { headers: { origin: `http://127.0.0.1:${s.port}` } });
  ws.on('message', (d) => { const t = d.toString(); if (JSON.parse(t).type === 'state') texts.push(t); });
  return new Promise((ok) => ws.on('open', () => ok({ ws, texts })));
}

it('a burst of changes becomes fewer pushes, and the last state is never lost', async () => {
  const s = await bootServer();
  s.setLimits({ global: 9, perProject: 9 });
  await ui(s, '/api/agents', 'POST', { slug: 'fix-login', profile: 'developer' });
  await modEvent(s, 'fix-login', 'session.start');
  const { ws, texts } = await openUi(s);
  texts.length = 0;
  for (let i = 0; i < 10; i++) {
    await modEvent(s, 'fix-login', 'turn.start');
    await modEvent(s, 'fix-login', 'turn.complete');
  }
  await modEvent(s, 'fix-login', 'turn.start'); // the last change: the agent is working
  await until(() => texts.some((t) => JSON.parse(t).agents[0]?.state === 'working' && t === texts[texts.length - 1]));
  expect(texts.length).toBeLessThan(21); // 21 events, at most one push each, in practice a handful
  expect(JSON.parse(texts[texts.length - 1]!).agents[0].state).toBe((await state(s)).agents[0].state);
  ws.close();
});

it('two sockets of the same project get the same text for one push', async () => {
  const s = await bootServer();
  s.setLimits({ global: 9, perProject: 9 });
  await ui(s, '/api/agents', 'POST', { slug: 'fix-login', profile: 'developer' });
  await modEvent(s, 'fix-login', 'session.start');
  const a = await openUi(s);
  const b = await openUi(s);
  a.texts.length = 0;
  b.texts.length = 0;
  await modEvent(s, 'fix-login', 'turn.start');
  await until(() => a.texts.length > 0 && b.texts.length > 0);
  expect(a.texts[a.texts.length - 1]).toBe(b.texts[b.texts.length - 1]);
  a.ws.close();
  b.ws.close();
});
