import { it, expect } from 'vitest';
import WebSocket from 'ws';
import { autoClose, bootServer, modEvent, req, ui, until } from './helpers';

autoClose();

it('a completed turn lands in the agent reading list, numbered, and is served to the UI', async () => {
  const s = await bootServer();
  await modEvent(s, 'shop-api', 'turn.complete', { answer: '## Found it\n\nThe timeout was 30s.' });
  await modEvent(s, 'shop-api', 'turn.complete', { answer: 'Second answer' });
  const list = (await ui(s, '/api/reading/shop-api')).body.entries;
  expect(list.map((e: any) => [e.n, e.text])).toEqual([[1, '## Found it\n\nThe timeout was 30s.'], [2, 'Second answer']]);
  expect(typeof list[0].at).toBe('string');
});
it('an empty or missing answer adds nothing', async () => {
  const s = await bootServer();
  await modEvent(s, 'shop-api', 'turn.complete', { answer: '' });
  await modEvent(s, 'shop-api', 'turn.complete');
  await modEvent(s, 'shop-api', 'turn.complete', { answer: 42 });
  expect((await ui(s, '/api/reading/shop-api')).body.entries).toEqual([]);
});
it('needs the UI token, and an unknown name is just empty', async () => {
  const s = await bootServer();
  expect((await req(s, '/api/reading/shop-api', { token: s.sessionTokenFor('shop-api') })).status).toBe(401);
  expect((await ui(s, '/api/reading/ghost-job')).body.entries).toEqual([]);
});
it('pushes the new entry over the UI WebSocket as it happens', async () => {
  const s = await bootServer();
  const messages: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/ui?token=${s.token}`, { headers: { origin: `http://127.0.0.1:${s.port}` } });
  ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
  await new Promise<void>((ok) => ws.on('open', () => ok()));
  await modEvent(s, 'shop-api', 'turn.complete', { answer: 'live answer' });
  await until(() => messages.some((m) => m.type === 'reading' && m.slug === 'shop-api' && m.entry.text === 'live answer'));
  ws.close();
});
