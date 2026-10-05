import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { applyTemplate } from '../src/server/templates/apply';
import { gitSync, makeRepo, removeDir, type TestRepo } from './git-helpers';

vi.setConfig({ testTimeout: 60_000 });

const dirs: string[] = [];
const repos: TestRepo[] = [];
afterEach(() => {
  while (dirs.length) removeDir(dirs.pop()!);
  while (repos.length) removeDir(repos.pop()!.base);
});
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'tpl-apply-')); dirs.push(d); return d; };
const planOf = (root: string): any => JSON.parse(readFileSync(join(root, '.console', 'plan.json'), 'utf8'));
const base = (root: string, extra: Record<string, unknown> = {}) => ({ templateId: 'backend-java', root, name: 'shop-api', create: false, configDir: tmp(), ...extra });

it('new folder: creates it, starts a repository with an empty first commit, copies the template and writes the plan', async () => {
  const root = join(tmp(), 'brand new');
  const r = await applyTemplate(base(root, { create: true }));
  expect(r).toEqual({ ok: true });
  expect(existsSync(join(root, '.git'))).toBe(true);
  expect(gitSync(root, 'log', '--format=%s')).toBe('chore: start');
  expect(gitSync(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  for (const f of ['profiles/backend.md', 'profiles/dba.md', 'main.md', 'rules.md', 'plan.json']) expect(existsSync(join(root, '.console', f)), f).toBe(true);
  expect(existsSync(join(root, '.console', 'state', 'agents.json'))).toBe(true);
  expect(planOf(root)).toMatchObject({
    name: 'shop-api', profiles: ['backend', 'dba'], docs: ['README.md', 'CHANGELOG.md'], buildCommand: 'mvn -q -DskipTests package', testCommand: 'mvn test', squash: true,
  });
  expect(readFileSync(join(root, '.console', 'rules.md'), 'utf8')).toMatch(/Java backend/);
});

it('never writes a CLAUDE.md (it would dirty the user checkout and would not reach the worktrees)', async () => {
  const root = join(tmp(), 'proj');
  await applyTemplate(base(root, { create: true }));
  expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
  expect(gitSync(root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
});

it('an existing repository is left as it is: no commit, no init', async () => {
  const t = makeRepo();
  repos.push(t);
  const before = gitSync(t.repo, 'rev-parse', 'HEAD');
  expect(await applyTemplate(base(t.repo))).toEqual({ ok: true });
  expect(gitSync(t.repo, 'rev-parse', 'HEAD')).toBe(before);
  expect(existsSync(join(t.repo, '.console', 'main.md'))).toBe(true);
});

it('a folder that is not a repository stays one that is not, unless the user asked', async () => {
  const root = tmp();
  expect(await applyTemplate(base(root))).toEqual({ ok: true });
  expect(existsSync(join(root, '.git'))).toBe(false);
  const asked = tmp();
  expect(await applyTemplate(base(asked, { init: true }))).toEqual({ ok: true });
  expect(gitSync(asked, 'log', '--format=%s')).toBe('chore: start');
});

it('a repository without commits gets the first commit when the user asked for init', async () => {
  const t = makeRepo({ commit: false });
  repos.push(t);
  expect(await applyTemplate(base(t.repo, { init: true }))).toEqual({ ok: true });
  expect(gitSync(t.repo, 'log', '--format=%s')).toBe('chore: start');
});

it('commands: what the user typed beats the detected ones, which beat the template (an empty answer is kept as none)', async () => {
  const root = tmp();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'b', test: 't', lint: 'l' } }));
  expect(await applyTemplate(base(root, { test: 'custom test', lint: '' }))).toEqual({ ok: true });
  const plan = planOf(root);
  expect(plan.testCommand).toBe('custom test'); // typed
  expect(plan.buildCommand).toBe('npm run build'); // detected over the template's mvn
  expect(plan.lintCommand).toBeUndefined(); // typed empty
  const bare = tmp();
  expect(await applyTemplate(base(bare))).toEqual({ ok: true });
  expect(planOf(bare)).toMatchObject({ buildCommand: 'mvn -q -DskipTests package', testCommand: 'mvn test' }); // nothing detected: the template's
});

it('is idempotent: a second run changes nothing but keeps the plan name, date and agents', async () => {
  const root = join(tmp(), 'idem');
  const o = base(root, { create: true });
  await applyTemplate(o);
  const first = readFileSync(join(root, '.console', 'plan.json'), 'utf8');
  writeFileSync(join(root, '.console', 'state', 'agents.json'), JSON.stringify([{ slug: 'fix-login', profile: 'backend', createdAt: 'x' }]));
  const head = gitSync(root, 'rev-parse', 'HEAD');
  expect(await applyTemplate({ ...o, name: 'another-name' })).toEqual({ ok: true });
  expect(JSON.parse(readFileSync(join(root, '.console', 'plan.json'), 'utf8'))).toEqual(JSON.parse(first)); // same content (key order may differ)
  expect(planOf(root).name).toBe('shop-api');
  expect(gitSync(root, 'rev-parse', 'HEAD')).toBe(head);
  expect(JSON.parse(readFileSync(join(root, '.console', 'state', 'agents.json'), 'utf8'))).toHaveLength(1);
});

it('the generic template offers every profile (no restriction) and no docs', async () => {
  const root = tmp();
  expect(await applyTemplate(base(root, { templateId: 'generic' }))).toEqual({ ok: true });
  const plan = planOf(root);
  expect(plan.profiles).toBeUndefined();
  expect(plan.docs).toBeUndefined();
  expect(existsSync(join(root, '.console', 'profiles'))).toBe(false);
});

it('refusals: unknown or invalid template, a relative or missing folder', async () => {
  const root = tmp();
  expect(await applyTemplate(base(root, { templateId: 'nope-none' }))).toMatchObject({ ok: false, code: 'template.notFound' });
  expect(await applyTemplate(base(root, { templateId: '../x' }))).toMatchObject({ ok: false, code: 'template.notFound' });
  const configDir = tmp();
  mkdirSync(join(configDir, 'templates', 'broken'), { recursive: true });
  writeFileSync(join(configDir, 'templates', 'broken', 'template.json'), '{nope');
  expect(await applyTemplate(base(root, { templateId: 'broken', configDir }))).toMatchObject({ ok: false, code: 'template.invalid' });
  expect(await applyTemplate(base('relative/dir'))).toMatchObject({ ok: false, code: 'plan.badRoot' });
  expect(await applyTemplate(base(join(root, 'missing')))).toMatchObject({ ok: false, code: 'plan.badRoot' });
  expect(existsSync(join(root, 'missing'))).toBe(false);
});

it('a user template is applied with its own files', async () => {
  const configDir = tmp();
  const dir = join(configDir, 'templates', 'my-own');
  mkdirSync(join(dir, 'profiles'), { recursive: true });
  writeFileSync(join(dir, 'template.json'), JSON.stringify({ schema: 1, id: 'my-own', name: { en: 'Mine' }, description: { en: 'd' }, commands: { test: 'make check' }, git: { squash: false, secretPatterns: ['*.vault'] }, defaults: { model: 'opus', agentTokens: 5000, maxActive: 2 }, detect: false }));
  writeFileSync(join(dir, 'rules.md'), 'My rules.');
  writeFileSync(join(dir, 'profiles', 'backend.md'), '---\nname: backend\ndescription: mine\n---\nBODY');
  const root = tmp();
  expect(await applyTemplate(base(root, { templateId: 'my-own', configDir }))).toEqual({ ok: true });
  expect(planOf(root)).toMatchObject({ testCommand: 'make check', squash: false, secretPatterns: ['*.vault'], model: 'opus', agentTokens: 5000, maxActive: 2 });
  expect(readFileSync(join(root, '.console', 'rules.md'), 'utf8')).toBe('My rules.');
  expect(existsSync(join(root, '.console', 'main.md'))).toBe(false);
  expect(readFileSync(join(root, '.console', 'profiles', 'backend.md'), 'utf8')).toContain('mine');
});
