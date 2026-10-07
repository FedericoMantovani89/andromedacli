// The console with no project open (the welcome screen) and the projects it remembers.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { autoClose, bootServer, req, state, ui, until } from './helpers';

vi.setConfig({ testTimeout: 30_000 });
autoClose();

const folder = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const configWith = (projects?: { root: string; name: string }[]): string => {
  const dir = folder('w-cfg-');
  if (projects) writeFileSync(join(dir, 'projects.json'), JSON.stringify(projects));
  return dir;
};

it('starts with no project: /api/host lists none, project routes answer project.notFound, the page and its texts are served', async () => {
  const s = await bootServer({ noProject: true });
  const host = await ui(s, '/api/host');
  expect(host.status).toBe(200);
  expect(host.body).toMatchObject({ projects: [], language: 'en', needsSetup: false });
  expect(host.body.languages).toEqual(expect.arrayContaining(['en', 'it']));
  const st = await ui(s, '/api/state');
  expect(st.status).toBe(404);
  expect(st.body.code).toBe('project.notFound');
  expect((await req(s, '/i18n/en')).status).toBe(200); // no token needed, as before
  expect((await req(s, '/api/host')).status).toBe(401); // the token is needed
  expect((await req(s, '/v1/events', { method: 'POST', token: 'nope', body: {} })).status).toBe(401);
});

it('opens the remembered projects when no folder is given', async () => {
  const root = folder('w-project-');
  const s = await bootServer({ noProject: true, configDir: configWith([{ root, name: 'old-shop' }]) });
  const host = await ui(s, '/api/host');
  expect(host.body.projects.map((p: any) => p.name)).toEqual(['old-shop']);
  expect((await state(s)).project.name).toBe('old-shop');
  await until(async () => (await state(s)).main.status === 'running');
});

it('skips a remembered project whose folder is gone and still starts', async () => {
  const s = await bootServer({ noProject: true, configDir: configWith([{ root: join(tmpdir(), 'w-gone-folder-xyz'), name: 'gone-shop' }]) });
  expect((await ui(s, '/api/host')).body.projects).toEqual([]);
});

it('the first project can be created from the empty state, and then answers like any project', async () => {
  const root = folder('w-first-');
  mkdirSync(root, { recursive: true });
  const s = await bootServer({ noProject: true });
  const made = await ui(s, '/api/projects', 'POST', { root, name: 'first-project' });
  expect(made.status).toBe(201);
  expect(made.body).toEqual({ name: 'first-project' });
  expect((await ui(s, '/api/host')).body.projects.map((p: any) => p.name)).toEqual(['first-project']);
  expect((await state(s)).project.name).toBe('first-project');
  await until(async () => (await state(s)).main.status === 'running');
});
