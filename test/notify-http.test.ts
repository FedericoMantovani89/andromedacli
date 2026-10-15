import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { autoClose, usePipePty, bootServer, configFileOf, mod, req, ui, state, until } from './helpers';
import type { Notifier, NotifierMessage } from '../src/server/notify/notifier';

autoClose();
usePipePty(); // this file never reads the terminal: its sessions run on plain pipes

function recorder(o: { available?: boolean } = {}) {
  const sent: NotifierMessage[] = [];
  const notifier: Notifier = { available: async () => o.available ?? true, notify: async (n) => { sent.push(n); } };
  return { sent, notifier };
}

it('/api/presence needs the token, takes a report (204) and refuses anything else (400)', async () => {
  const s = await bootServer({ notifier: recorder().notifier });
  const report = { focused: true, visible: true, drawerOpen: false, active: 'shop-api' };
  expect((await req(s, '/api/presence', { method: 'POST', body: report })).status).toBe(401);
  expect((await ui(s, '/api/presence', 'POST', report)).status).toBe(204);
  expect((await ui(s, '/api/presence', 'POST', { focused: 'yes' })).status).toBe(400);
  expect((await ui(s, '/api/presence', 'POST', null)).status).toBe(400);
});

it('the state carries the toast status and the settings; unknown never reads as ok', async () => {
  const s = await bootServer({ notifier: recorder().notifier });
  await until(async () => (await state(s)).notifications?.toast === 'ok');
  const st = await state(s);
  expect(st.notifications.config.enabled.question).toBe(true);
  expect(st.notifications.config.groupSeconds).toBe(5);

  const down = await bootServer({ notifier: recorder({ available: false }).notifier });
  await until(async () => (await state(down)).notifications?.toast === 'unavailable');
});

it('the test button sends one real toast through the notifier and answers ok', async () => {
  const r = recorder();
  const s = await bootServer({ notifier: r.notifier });
  expect((await req(s, '/api/notifications/test', { method: 'POST' })).status).toBe(401);
  const res = await ui(s, '/api/notifications/test', 'POST');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ok: true });
  expect(r.sent).toHaveLength(1);
  expect(r.sent[0]).toMatchObject({ title: 'Test notification' });
});

it('the test button says ok:false when no toast can be shown', async () => {
  const s = await bootServer({ notifier: recorder({ available: false }).notifier });
  await until(async () => (await state(s)).notifications?.toast === 'unavailable');
  expect((await ui(s, '/api/notifications/test', 'POST')).body).toEqual({ ok: false });
});

it('a question from an agent raises a toast whose click opens the queue on that item', async () => {
  const r = recorder();
  const s = await bootServer({ notifier: r.notifier, config: { notifications: { groupSeconds: 1 } } });
  s.setLimits({ global: 9, perProject: 9 });
  await ui(s, '/api/agents', 'POST', { slug: 'fix-login', profile: 'developer' });
  const { id } = (await mod(s, 'fix-login', '/v1/tools/ask_user', 'POST', { question: 'Which color?' })).body;
  await until(() => r.sent.length === 1, 6000);
  expect(r.sent[0]!.message).toBe('fix-login: Which color?');
  // The click opens the page with a single-use code, never the token.
  const open = new URL(r.sent[0]!.open!);
  expect(open.origin).toBe(`http://127.0.0.1:${s.port}`);
  expect(open.searchParams.get('token')).toBeNull();
  expect(open.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  expect(open.searchParams.get('project')).toBe('shop-api');
  expect(open.hash).toBe(`#queue=${id}`);
});

it('PUT /api/config saves the notification settings, applies them at once and refuses bad values', async () => {
  const s = await bootServer({ notifier: recorder().notifier });
  const ok = await ui(s, '/api/config', 'PUT', { notifications: { enabled: { question: false }, quietHours: { enabled: true, from: '23:30' }, groupSeconds: 9 } });
  expect(ok.status).toBe(200);
  const saved = JSON.parse(readFileSync(configFileOf(s), 'utf8')).notifications;
  expect(saved.enabled.question).toBe(false);
  // The file keeps only what was changed (the generic patch of Phase 6E); the effective settings are complete.
  expect(saved.quietHours).toEqual({ enabled: true, from: '23:30' });
  expect(saved.groupSeconds).toBe(9);
  const effective = (await state(s)).notifications.config;
  expect(effective.enabled.permission).toBe(true);
  expect(effective.quietHours).toEqual({ enabled: true, from: '23:30', to: '07:00' });
  expect(effective.groupSeconds).toBe(9);

  for (const bad of [{ groupSeconds: 0 }, { groupSeconds: 61 }, { quietHours: { from: '25:00' } }, { enabled: { nope: true } }, { sound: 'yes' }]) {
    const res = await ui(s, '/api/config', 'PUT', { notifications: bad });
    expect(res.status).toBe(422);
    // a number out of its range names the limits; anything else is the generic refusal
    expect(res.body.code).toBe('groupSeconds' in bad ? 'config.outOfRange' : 'config.invalid');
    if ('groupSeconds' in bad) expect(res.body.params).toEqual({ path: 'notifications.groupSeconds', min: 1, max: 60 });
  }
  expect((await state(s)).notifications.config.groupSeconds).toBe(9); // nothing changed
});

// 'a disabled type raises no toast' is in notify-service.test.ts ('a disabled type does not notify, the others still do'); the config reaches the
// service through the test above. The HTTP version waited a fixed 1.5 s to see nothing happen.
