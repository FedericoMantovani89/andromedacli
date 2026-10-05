import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { expect, it } from 'vitest';
import { saveTemplate } from '../src/server/templates/save';
import { findTemplate } from '../src/server/templates/load';
import { applyTemplate } from '../src/server/templates/apply';
import { PlanStore } from '../src/server/plan-store';
import { autoClose, bootServer, configFileOf, req, ui } from './helpers';

autoClose();
const tmp = (): string => mkdtempSync(join(tmpdir(), 'tpl-save-'));

function workingPlan(): string {
  const root = tmp();
  const store = new PlanStore(root);
  store.init('shop-api');
  store.setTestCommand('make check');
  store.setSquash(false);
  store.setFields({ buildCommand: 'make', profiles: ['backend'], docs: ['README.md'], secretPatterns: ['*.vault'], model: 'opus', agentTokens: 5000, maxActive: 2 }, ['backend', 'dba', 'frontend']);
  mkdirSync(join(root, '.console', 'profiles'), { recursive: true });
  writeFileSync(join(root, '.console', 'profiles', 'backend.md'), '---\nname: backend\ndescription: mine\n---\nBODY');
  writeFileSync(join(root, '.console', 'rules.md'), 'RULES');
  writeFileSync(join(root, '.console', 'main.md'), 'MAIN');
  return root;
}

it('saves a copy of the plan that loads as a valid user template', () => {
  const root = workingPlan();
  const configDir = tmp();
  const r = saveTemplate({ planRoot: root, plan: new PlanStore(root).plan, configDir, id: 'my-stack', name: { en: 'My stack', it: 'Il mio stack' } });
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

it('a later change to the plan never touches the template; applying it makes the same plan elsewhere', async () => {
  const root = workingPlan();
  const configDir = tmp();
  saveTemplate({ planRoot: root, plan: new PlanStore(root).plan, configDir, id: 'my-stack' });
  new PlanStore(root).setTestCommand('changed');
  writeFileSync(join(root, '.console', 'rules.md'), 'CHANGED');
  expect(findTemplate('my-stack', { configDir })!.data!.commands.test).toBe('make check');
  const other = tmp();
  expect(await applyTemplate({ templateId: 'my-stack', root: other, name: 'copy-plan', create: false, configDir })).toEqual({ ok: true });
  expect(JSON.parse(readFileSync(join(other, '.console', 'plan.json'), 'utf8'))).toMatchObject({ name: 'copy-plan', testCommand: 'make check', squash: false, profiles: ['backend'] });
  expect(readFileSync(join(other, '.console', 'rules.md'), 'utf8')).toBe('RULES');
});

it('refuses a bad id, and an existing one unless overwrite is set', () => {
  const root = workingPlan();
  const configDir = tmp();
  const plan = new PlanStore(root).plan;
  for (const id of ['', 'Bad Id', '../x', 'a/b', 'x'.repeat(41)]) expect(saveTemplate({ planRoot: root, plan, configDir, id }), id).toMatchObject({ ok: false, code: 'template.idInvalid' });
  expect(saveTemplate({ planRoot: root, plan, configDir, id: 'my-stack' }).ok).toBe(true);
  expect(saveTemplate({ planRoot: root, plan, configDir, id: 'my-stack' })).toMatchObject({ ok: false, code: 'template.exists' });
  new PlanStore(root).setTestCommand('second');
  expect(saveTemplate({ planRoot: root, plan: new PlanStore(root).plan, configDir, id: 'my-stack', overwrite: true }).ok).toBe(true);
  expect(findTemplate('my-stack', { configDir })!.data!.commands.test).toBe('second');
});

it('a plan without rules or profiles saves without those files', () => {
  const root = tmp();
  const store = new PlanStore(root);
  store.init('shop-api');
  const configDir = tmp();
  expect(saveTemplate({ planRoot: root, plan: store.plan, configDir, id: 'bare-one' }).ok).toBe(true);
  expect(existsSync(join(configDir, 'templates', 'bare-one', 'rules.md'))).toBe(false);
  expect(existsSync(join(configDir, 'templates', 'bare-one', 'profiles'))).toBe(false);
  expect(findTemplate('bare-one', { configDir })!.valid).toBe(true);
});

it('HTTP: GET /api/templates lists them, POST /api/plans/save-template saves, refuses duplicates, needs the token', async () => {
  const s = await bootServer();
  const configDir = dirname(configFileOf(s));
  const list = (await ui(s, '/api/templates')).body as { id: string; source: string; valid: boolean }[];
  expect(list.map((t) => t.id)).toEqual(expect.arrayContaining(['backend-java', 'frontend-web', 'generic']));
  expect((await req(s, '/api/templates')).status).toBe(401);
  expect((await ui(s, '/api/plans/save-template', 'POST', { id: 'from-http', name: 'From http' })).status).toBe(201);
  expect(findTemplate('from-http', { configDir })!.valid).toBe(true);
  expect((await ui(s, '/api/templates')).body.find((t: any) => t.id === 'from-http')).toMatchObject({ source: 'user', valid: true });
  const again = await ui(s, '/api/plans/save-template', 'POST', { id: 'from-http' });
  expect(again.status).toBe(409);
  expect(again.body.code).toBe('template.exists');
  expect((await ui(s, '/api/plans/save-template', 'POST', { id: 'from-http', overwrite: true })).status).toBe(201);
  expect((await ui(s, '/api/plans/save-template', 'POST', { id: 'Bad Id' })).body.code).toBe('template.idInvalid');
  expect((await req(s, '/api/plans/save-template', { method: 'POST', body: { id: 'x-y-z' } })).status).toBe(401);
});
