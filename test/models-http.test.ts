import { it, expect } from 'vitest';
import http from 'node:http';
import { autoClose, bootServer, req, ui, until } from './helpers';

autoClose();

it('GET /api/models: aliases first, then the shipped list, with the saved choice', async () => {
  const s = await bootServer();
  const r = await ui(s, '/api/models');
  expect(r.status).toBe(200);
  expect(r.body.source).toBe('shipped');
  expect(r.body.models.slice(0, 4).map((m: any) => m.id)).toEqual(['opus', 'sonnet', 'haiku', 'fable']);
  expect(r.body.models.some((m: any) => m.id === 'claude-opus-5-5[1m]')).toBe(true);
  expect(r.body.current).toBe('');
  expect(r.body.missing).toBe(false);
});
it('a saved model that is not in the list stays current and is flagged missing; it is used at launch', async () => {
  const s = await bootServer();
  expect((await ui(s, '/api/config', 'PUT', { models: { agent: 'claude-gone-1' } })).status).toBe(200);
  const r = await ui(s, '/api/models');
  expect(r.body).toMatchObject({ current: 'claude-gone-1', missing: true });
  expect((await ui(s, '/api/config', 'PUT', { models: { agent: 'bad model' } })).status).toBe(422);
});
it('needs the UI token', async () => {
  const s = await bootServer();
  expect((await req(s, '/api/models')).status).toBe(401);
  expect((await req(s, '/api/models/refresh', { method: 'POST' })).status).toBe(401);
});
it('refresh downloads the catalog from a local address and merges it', async () => {
  const server = http.createServer((_q, res) => { res.end(JSON.stringify({ updated: '2026-10-05', models: [{ id: 'claude-new-9', label: 'New 9' }] })); });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as { port: number }).port;
  try {
    const s = await bootServer({ config: { models: { catalogUrl: `http://127.0.0.1:${port}/models.json` } } });
    const r = await ui(s, '/api/models/refresh', 'POST');
    expect(r.body.source).toBe('remote');
    expect(r.body.updated).toBe('2026-10-05');
    expect(r.body.models.map((m: any) => m.id)).toContain('claude-new-9');
    expect(r.body.models.map((m: any) => m.id)).toContain('claude-sonnet-5');
    await until(async () => (await ui(s, '/api/models')).body.source === 'remote');
  } finally { server.close(); }
});
