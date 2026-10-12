import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { expect, it } from 'vitest';
import { saveTemplate } from '../src/server/templates/save';
import { findTemplate } from '../src/server/templates/load';
import { applyTemplate } from '../src/server/templates/apply';
import { ProjectStore } from '../src/server/project-store';
import { autoClose, bootServer, configFileOf, req, ui } from './helpers';

autoClose();
const tmp = (): string => mkdtempSync(join(tmpdir(), 'tpl-save-'));

function workingProject(): string {
  const root = tmp();
  const store = new ProjectStore(root);
  store.init('shop-api');
  store.setTestCommand('make check');
  store.setSquash(false);
  store.setFields({ buildCommand: 'make', profiles: ['backend'], docs: ['README.md'], secretPatterns: ['*.vault'], model: 'opus', agentTokens: 5000, maxActive: 2 }, ['backend', 'dba', 'frontend']);
  mkdirSync(join(root, '.andromedaconsole', 'profiles'), { recursive: true });
  writeFileSync(join(root, '.andromedaconsole', 'profiles', 'backend.md'), '---\nname: backend\ndescription: mine\n---\nBODY');
  writeFileSync(join(root, '.andromedaconsole', 'rules.md'), 'RULES');
  writeFileSync(join(root, '.andromedaconsole', 'main.md'), 'MAIN');
  return root;
}

it('saves a copy of the project that loads as a valid user template', () => {
  const root = workingProject();
  const configDir = tmp();
  const r = saveTemplate({ projectRoot: root, project: new ProjectStore(root).project, configDir, id: 'my-stack', name: { en: 'My stack', it: 'Il mio stack' } });
  expect(r.ok).toBe(true);
  const t = findTemplate('my-stack', { configDir })!;
  expect(t.valid, t.reason).toBe(true);
  expect(t.source).toBe('user');
  expect(t.data).toMatchObject({
    name: { en: 'My stack', it: 'Il mio stack' }, profiles: ['backend'], commands: { build: 'make', test: 'make check' },
    git: { squash: false, secretPatterns: ['*.vault'] }, docs: ['README.md'], defaults: { model: 'opus', agentTokens: 5000, maxActive: 2 },
  });
  const dir = join(configDir, 'templates', 'my-stack');
  expect(readFileSync(join(dir, 'rules.md'), 'utf8')).toBe('RULES');
  expect(readFileSync(join(dir, 'main.md'), 'utf8')).toBe('MAIN');
  expect(readFileSync(join(dir, 'profiles', 'backend.md'), 'utf8')).toContain('mine');
});

it('a later change to the project never touches the template; applying it makes the same project elsewhere', async () => {
  const root = workingProject();
  const configDir = tmp();
  saveTemplate({ projectRoot: root, project: new ProjectStore(root).project, configDir, id: 'my-stack' });
  new ProjectStore(root).setTestCommand('changed');
  writeFileSync(join(root, '.andromedaconsole', 'rules.md'), 'CHANGED');
  expect(findTemplate('my-stack', { configDir })!.data!.commands.test).toBe('make check');
  const other = tmp();
  expect(await applyTemplate({ templateId: 'my-stack', root: other, name: 'copy-project', create: false, configDir })).toEqual({ ok: true });
  expect(JSON.parse(readFileSync(join(other, '.andromedaconsole', 'project.json'), 'utf8'))).toMatchObject({ name: 'copy-project', testCommand: 'make check', squash: false, profiles: ['backend'] });
  expect(readFileSync(join(other, '.andromedaconsole', 'rules.md'), 'utf8')).toBe('RULES');
});

it('refuses a bad id, and an existing one unless overwrite is set', () => {
  const root = workingProject();
  const configDir = tmp();
  const project = new ProjectStore(root).project;
  for (const id of ['', 'Bad Id', '../x', 'a/b', 'x'.repeat(41)]) expect(saveTemplate({ projectRoot: root, project, configDir, id }), id).toMatchObject({ ok: false, code: 'template.idInvalid' });
  expect(saveTemplate({ projectRoot: root, project, configDir, id: 'my-stack' }).ok).toBe(true);
  expect(saveTemplate({ projectRoot: root, project, configDir, id: 'my-stack' })).toMatchObject({ ok: false, code: 'template.exists' });
  new ProjectStore(root).setTestCommand('second');
  expect(saveTemplate({ projectRoot: root, project: new ProjectStore(root).project, configDir, id: 'my-stack', overwrite: true }).ok).toBe(true);
  expect(findTemplate('my-stack', { configDir })!.data!.commands.test).toBe('second');
});

it('a project without rules or profiles saves without those files', () => {
  const root = tmp();
  const store = new ProjectStore(root);
  store.init('shop-api');
  const configDir = tmp();
  expect(saveTemplate({ projectRoot: root, project: store.project, configDir, id: 'bare-one' }).ok).toBe(true);
  expect(existsSync(join(configDir, 'templates', 'bare-one', 'rules.md'))).toBe(false);
  expect(existsSync(join(configDir, 'templates', 'bare-one', 'profiles'))).toBe(false);
  expect(findTemplate('bare-one', { configDir })!.valid).toBe(true);
});

it('HTTP: GET /api/templates lists them, POST /api/projects/save-template saves, refuses duplicates, needs the token', async () => {
  const s = await bootServer();
  const configDir = dirname(configFileOf(s));
  const list = (await ui(s, '/api/templates')).body as { id: string; source: string; valid: boolean }[];
  expect(list.map((t) => t.id)).toEqual(expect.arrayContaining(['backend-java', 'frontend-web', 'generic']));
  expect((await req(s, '/api/templates')).status).toBe(401);
  expect((await ui(s, '/api/projects/save-template', 'POST', { id: 'from-http', name: 'From http' })).status).toBe(201);
  expect(findTemplate('from-http', { configDir })!.valid).toBe(true);
  expect((await ui(s, '/api/templates')).body.find((t: any) => t.id === 'from-http')).toMatchObject({ source: 'user', valid: true });
  const again = await ui(s, '/api/projects/save-template', 'POST', { id: 'from-http' });
  expect(again.status).toBe(409);
  expect(again.body.code).toBe('template.exists');
  expect((await ui(s, '/api/projects/save-template', 'POST', { id: 'from-http', overwrite: true })).status).toBe(201);
  expect((await ui(s, '/api/projects/save-template', 'POST', { id: 'Bad Id' })).body.code).toBe('template.idInvalid');
  expect((await req(s, '/api/projects/save-template', { method: 'POST', body: { id: 'x-y-z' } })).status).toBe(401);
});
