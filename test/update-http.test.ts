import { expect, it } from 'vitest';
import WebSocket from 'ws';
import { autoClose, bootServer, state, ui, until } from './helpers';
import type { UpdateControl, UpdateState } from '../src/shared/update';

autoClose();

function fakeUpdates(initial?: UpdateState): UpdateControl & { calls: string[]; set(s: UpdateState | undefined): void } {
  let current = initial;
  let notify: () => void = () => undefined;
  const calls: string[] = [];
  return {
    calls,
    state: () => current,
    download: () => { calls.push('download'); },
    install: () => { calls.push('install'); },
    onChange: (cb) => { notify = cb; },
    set: (s) => { current = s; notify(); },
  };
}

it('the state carries the update only while there is one', async () => {
  const updates = fakeUpdates();
  const s = await bootServer({ updates });
  expect((await state(s)).update).toBeUndefined();
  updates.set({ phase: 'available', version: '0.0.2' });
  expect((await state(s)).update).toEqual({ phase: 'available', version: '0.0.2' });
  updates.set({ phase: 'downloading', version: '0.0.2', percent: 40 });
  expect((await state(s)).update).toEqual({ phase: 'downloading', version: '0.0.2', percent: 40 });
});

it('a change of the update is pushed to the page without any other event', async () => {
  const updates = fakeUpdates();
  const s = await bootServer({ updates });
  const texts: string[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/ui?token=${s.token}`, { headers: { origin: `http://127.0.0.1:${s.port}` } });
  ws.on('message', (d) => { const t = d.toString(); if (JSON.parse(t).type === 'state') texts.push(t); });
  await new Promise<void>((ok) => ws.on('open', () => ok()));
  texts.length = 0;
  updates.set({ phase: 'ready', version: '0.0.2' });
  await until(() => texts.some((t) => JSON.parse(t).update?.phase === 'ready'));
  ws.close();
});

it('download and install reach the app, each only on the user\'s request', async () => {
  const updates = fakeUpdates({ phase: 'available', version: '0.0.2' });
  const s = await bootServer({ updates });
  expect((await ui(s, '/api/update/download', 'POST')).status).toBe(204);
  expect(updates.calls).toEqual(['download']);
  expect((await ui(s, '/api/update/install', 'POST')).status).toBe(204);
  expect(updates.calls).toEqual(['download', 'install']);
});

it('without the desktop app there is no update and the routes answer not found; the token is still required', async () => {
  const s = await bootServer();
  expect((await state(s)).update).toBeUndefined();
  expect((await ui(s, '/api/update/download', 'POST')).status).toBe(404);
  expect((await ui(s, '/api/update/install', 'POST')).status).toBe(404);
  const withApp = await bootServer({ updates: fakeUpdates({ phase: 'ready', version: '0.0.2' }) });
  const noToken = await fetch(`http://127.0.0.1:${withApp.port}/api/update/install`, { method: 'POST' });
  expect(noToken.status).toBe(401);
});

it('install answers at once even if it takes long (it stops the server itself, which waits for open requests)', async () => {
  let release: () => void = () => undefined;
  const updates = { ...fakeUpdates({ phase: 'ready', version: '0.0.2' }), install: () => new Promise<void>((ok) => { release = ok; }) };
  const s = await bootServer({ updates });
  const t0 = Date.now();
  expect((await ui(s, '/api/update/install', 'POST')).status).toBe(204);
  expect(Date.now() - t0).toBeLessThan(2000);
  release();
});
