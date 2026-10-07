import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectStore } from '../src/server/project-store';
import { autoClose, bootServer, mod, req, state, ui, until, type Running } from './helpers';
import { makeRepo, removeDir, type TestRepo } from './git-helpers';
import { worktreePathFor } from '../src/server/git/worktree';

vi.setConfig({ testTimeout: 60_000 });
autoClose();
const repos: TestRepo[] = [];
afterEach(() => { while (repos.length) removeDir(repos.pop()!.base); });

const KNOWN = ['backend', 'dba', 'frontend', 'reviewer', 'recovery'];
const newStore = (): ProjectStore => { const s = new ProjectStore(mkdtempSync(join(tmpdir(), 'pf-'))); s.init('shop-api'); return s; };
const put = (s: Running, body: unknown) => ui(s, '/api/project', 'PUT', body);
const spawn = (s: Running, name: string, extra: Record<string, unknown> = {}) =>
  mod(s, 'shop-api', '/v1/tools/spawn_agent', 'POST', { name, profile: 'backend', goal: 'g', ...extra });

it('setFields stores, replaces and clears every field, and a bad one changes nothing', () => {
  const s = newStore();
  s.setFields({ buildCommand: ' make ', lintCommand: 'make lint', profiles: ['backend'], model: 'opus', agentTokens: 5000, maxActive: 2, docs: ['README.md'], secretPatterns: ['*.vault'] }, KNOWN);
  expect(s.project).toMatchObject({ buildCommand: 'make', lintCommand: 'make lint', profiles: ['backend'], model: 'opus', agentTokens: 5000, maxActive: 2, docs: ['README.md'], secretPatterns: ['*.vault'] });
  s.setFields({ model: 'haiku', docs: [], lintCommand: '' }, KNOWN);
  expect(s.project.model).toBe('haiku');
  expect(s.project.docs).toBeUndefined();
  expect(s.project.lintCommand).toBeUndefined();
  expect(s.project.buildCommand).toBe('make'); // not mentioned: kept
  const bad: Record<string, unknown>[] = [
    { buildCommand: 'a\nb' }, { buildCommand: 'x'.repeat(501) }, { profiles: ['nonsense'] }, { profiles: 'backend' }, { model: 'x&calc' },
    { agentTokens: 999 }, { agentTokens: 100_000_001 }, { agentTokens: 1.5 }, { maxActive: 0 }, { maxActive: 65 },
    { docs: Array.from({ length: 21 }, (_, i) => `f${i}.md`) }, { docs: ['x'.repeat(201)] }, { secretPatterns: [5] },
  ];
  const before = JSON.stringify(s.project);
  for (const b of bad) expect(() => s.setFields({ model: 'opus', ...b }, KNOWN), JSON.stringify(b)).toThrow(/project\.fieldInvalid/);
  expect(JSON.stringify(s.project)).toBe(before);
});

it('fields() is empty for a damaged project.json instead of throwing', () => {
  const root = mkdtempSync(join(tmpdir(), 'pf-'));
  mkdirSync(join(root, '.console'));
  writeFileSync(join(root, '.console', 'project.json'), '{nope');
  expect(new ProjectStore(root).fields()).toEqual({});
});

it('PUT /api/project sets and echoes the new fields, clears them, and validates before writing', async () => {
  const s = await bootServer();
  const r = await put(s, { buildCommand: 'make', model: 'opus', agentTokens: 5000, maxActive: 2, docs: ['README.md'], secretPatterns: ['*.vault'], lintCommand: 'make lint' });
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ buildCommand: 'make', model: 'opus', agentTokens: 5000, maxActive: 2, docs: ['README.md'], secretPatterns: ['*.vault'], lintCommand: 'make lint' });
  expect((await put(s, { model: null, docs: [] })).body).toEqual({});
  expect((await put(s, { testCommand: 'npm test', maxActive: 3 })).body).toEqual({ testCommand: 'npm test', maxActive: 3 });
  const before = (await state(s)).project;
  for (const [body, field] of [[{ maxActive: 0 }, 'maxActive'], [{ model: 'x y' }, 'model'], [{ profiles: ['nope'] }, 'profiles'], [{ agentTokens: 'many' }, 'agentTokens'], [{ lintCommand: 'a\nb' }, 'lintCommand']] as [unknown, string][]) {
    const bad = await put(s, { buildCommand: 'changed', ...(body as object) });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ code: 'project.fieldInvalid', params: { field } });
  }
  expect((await state(s)).project).toEqual(before);
  expect((await put(s, {})).status).toBe(400);
  expect((await req(s, '/api/project', { method: 'PUT', body: { maxActive: 2 } })).status).toBe(401);
});

it('the project profiles are what the picker shows and what spawn accepts; an internal spawn is exempt', async () => {
  const s = await bootServer();
  expect((await state(s)).profiles).toEqual(KNOWN);
  expect((await put(s, { profiles: ['backend'] })).status).toBe(200);
  expect((await state(s)).profiles).toEqual(['backend']);
  const refused = await ui(s, '/api/agents', 'POST', { slug: 'ui-work', profile: 'frontend' });
  expect(refused.status).toBe(422);
  expect(refused.body.code).toBe('profile.invalid');
  expect((await spawn(s, 'ui-work', { profile: 'frontend' })).body).toMatchObject({ status: 'error', code: 'profile.invalid' });
  expect((await ui(s, '/api/agents', 'POST', { slug: 'api-work', profile: 'backend' })).status).toBe(201);
  await put(s, { profiles: [] }); // clears: everything is offered again
  expect((await state(s)).profiles).toEqual(KNOWN);
});

it('model: the request beats the project; the project is used when nothing else names one', async () => {
  const s = await bootServer();
  await put(s, { model: 'opus' });
  expect((await spawn(s, 'project-model')).body.status).toBe('started');
  const a = s.lastLaunchArgs('project-model')!;
  expect(a[a.indexOf('--model') + 1]).toBe('opus');
  expect((await spawn(s, 'request-model', { model: 'haiku' })).body.status).toBe('started');
  const b = s.lastLaunchArgs('request-model')!;
  expect(b[b.indexOf('--model') + 1]).toBe('haiku');
});

it('maxActive limits this project: the next agent waits in the queue', async () => {
  const s = await bootServer();
  await put(s, { maxActive: 1 });
  expect((await spawn(s, 'first-job')).body.status).toBe('started');
  expect((await spawn(s, 'second-job')).body.status).toBe('queued');
  expect((await state(s)).limits.max).toBe(1);
});

it('secretPatterns of the project are added to the global ones for the guard', async () => {
  const s = await bootServer();
  await spawn(s, 'first-job');
  const cat = () => mod(s, 'first-job', '/v1/guard', 'POST', { tool: 'Bash', input: { command: 'cat db.vault' } });
  expect((await cat()).body.decision).toBe('allow');
  await put(s, { secretPatterns: ['*.vault'] });
  expect((await cat()).body).toMatchObject({ decision: 'deny', rule: 'secret.file' });
  expect((await mod(s, 'first-job', '/v1/guard', 'POST', { tool: 'Bash', input: { command: 'cat .env' } })).body.decision).toBe('deny'); // the global ones stay
});

it('budget: the profile beats the project default, which beats the configured one', async () => {
  const t = makeRepo({ remote: true });
  repos.push(t);
  mkdirSync(join(t.repo, '.console', 'profiles'), { recursive: true });
  writeFileSync(join(t.repo, '.console', 'profiles', 'dba.md'), '---\nname: dba\ndescription: no budget of its own\n---\nBODY');
  const s = await bootServer({ projectRoot: t.repo, config: { git: { worktrees: true } } });
  await put(s, { agentTokens: 5000 });
  const limitOf = (slug: string): number => JSON.parse(readFileSync(join(t.repo, '.console', 'state', 'tickets', `${slug}.json`), 'utf8')).budget?.limit;
  expect((await spawn(s, 'project-default', { profile: 'dba' })).body.status).toBe('started');
  await until(() => { try { return limitOf('project-default') !== undefined; } catch { return false; } });
  expect(limitOf('project-default')).toBe(5000);
  expect((await spawn(s, 'profile-wins')).body.status).toBe('started'); // the shipped backend profile sets 400000
  await until(() => { try { return limitOf('profile-wins') !== undefined; } catch { return false; } });
  expect(limitOf('profile-wins')).toBe(400000);
  expect(worktreePathFor(t.repo, 'project-default')).toBeTruthy();
});
