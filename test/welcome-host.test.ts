// The console with no plan open (the welcome screen) and the plans it remembers.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { autoClose, bootServer, req, state, ui, until } from './helpers';

vi.setConfig({ testTimeout: 30_000 });
autoClose();

const folder = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const configWith = (plans?: { root: string; name: string }[]): string => {
  const dir = folder('w-cfg-');
  if (plans) writeFileSync(join(dir, 'plans.json'), JSON.stringify(plans));
  return dir;
};

it('starts with no plan: /api/host lists none, plan routes answer plan.notFound, the page and its texts are served', async () => {
  const s = await bootServer({ noPlan: true });
  const host = await ui(s, '/api/host');
  expect(host.status).toBe(200);
  expect(host.body).toMatchObject({ plans: [], language: 'en', needsSetup: false });
  expect(host.body.languages).toEqual(expect.arrayContaining(['en', 'it']));
  const st = await ui(s, '/api/state');
  expect(st.status).toBe(404);
  expect(st.body.code).toBe('plan.notFound');
  expect((await req(s, '/i18n/en')).status).toBe(200); // no token needed, as before
  expect((await req(s, '/api/host')).status).toBe(401); // the token is needed
  expect((await req(s, '/v1/events', { method: 'POST', token: 'nope', body: {} })).status).toBe(401);
});

it('opens the remembered plans when no folder is given', async () => {
  const root = folder('w-plan-');
  const s = await bootServer({ noPlan: true, configDir: configWith([{ root, name: 'old-shop' }]) });
  const host = await ui(s, '/api/host');
  expect(host.body.plans.map((p: any) => p.name)).toEqual(['old-shop']);
  expect((await state(s)).plan.name).toBe('old-shop');
  await until(async () => (await state(s)).main.status === 'running');
});

it('skips a remembered plan whose folder is gone and still starts', async () => {
  const s = await bootServer({ noPlan: true, configDir: configWith([{ root: join(tmpdir(), 'w-gone-folder-xyz'), name: 'gone-shop' }]) });
  expect((await ui(s, '/api/host')).body.plans).toEqual([]);
});

it('the first plan can be created from the empty state, and then answers like any plan', async () => {
  const root = folder('w-first-');
  mkdirSync(root, { recursive: true });
  const s = await bootServer({ noPlan: true });
  const made = await ui(s, '/api/plans', 'POST', { root, name: 'first-plan' });
  expect(made.status).toBe(201);
  expect(made.body).toEqual({ name: 'first-plan' });
  expect((await ui(s, '/api/host')).body.plans.map((p: any) => p.name)).toEqual(['first-plan']);
  expect((await state(s)).plan.name).toBe('first-plan');
  await until(async () => (await state(s)).main.status === 'running');
});
