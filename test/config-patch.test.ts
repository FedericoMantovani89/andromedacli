import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyConfigPatch } from '../src/server/config';
import { autoClose, bootServer, configFileOf, ui } from './helpers';

autoClose();
const file = () => join(mkdtempSync(join(tmpdir(), 'cfgp-')), 'config.json');

it('deep-merges and keeps unknown and invalid entries already in the file', () => {
  const p = file();
  writeFileSync(p, JSON.stringify({ future: { a: 1 }, budget: { alertPercent: 500 }, git: { worktrees: false } }));
  const r = applyConfigPatch(p, { git: { testTimeoutMinutes: 30 } });
  expect(r.ok).toBe(true);
  expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ future: { a: 1 }, budget: { alertPercent: 500 }, git: { worktrees: false, testTimeoutMinutes: 30 } });
});
it('refuses per path and writes nothing', () => {
  const p = file();
  writeFileSync(p, '{"schema":1}');
  const before = readFileSync(p, 'utf8');
  for (const [patch, path] of [
    [{ budget: { loop: { sameCall: 0 } } }, 'budget.loop.sameCall'],
    [{ models: { catalogUrl: 'http://example.com/x.json' } }, 'models.catalogUrl'],
    [{ models: { agent: 'bad model' } }, 'models.agent'],
    [{ plugins: { cacheHours: 500 } }, 'plugins.cacheHours'],
    [{ git: 'x' }, 'git'],
  ] as [Record<string, unknown>, string][]) {
    expect(applyConfigPatch(p, patch)).toMatchObject({ ok: false, code: 'config.invalid', path });
  }
  expect(readFileSync(p, 'utf8')).toBe(before);
});
it('accepts https and local http catalog addresses and an empty model', () => {
  const p = file();
  expect(applyConfigPatch(p, { models: { agent: '', catalogUrl: 'https://example.com/models.json' } }).ok).toBe(true);
  expect(applyConfigPatch(p, { plugins: { catalogUrl: 'http://127.0.0.1:9/x.json' } }).ok).toBe(true);
});
it('an unreadable file is never overwritten', () => {
  const p = file();
  writeFileSync(p, '{nope');
  expect(applyConfigPatch(p, { guard: { mode: 'shadow' } })).toEqual({ ok: false, code: 'config.unreadable' });
  expect(readFileSync(p, 'utf8')).toBe('{nope');
});
it('claude.command and mod.enabled are not patchable', () => {
  const p = file();
  expect(applyConfigPatch(p, { claude: { command: ['x'] }, mod: { enabled: false } })).toEqual({ ok: false, code: 'config.invalid', path: '' });
});
it('PUT /api/config updates the limits in place and GET /api/options shows the config', async () => {
  const s = await bootServer();
  expect((await ui(s, '/api/config', 'PUT', { agents: { maxActiveGlobal: 2, maxActivePerProject: 2 } })).status).toBe(200);
  expect((await ui(s, '/api/state')).body.limits.max).toBe(2);
  const o = (await ui(s, '/api/options')).body;
  expect(o.config.agents.maxActiveGlobal).toBe(2);
  expect(o.config.agents.bypassPermissions).toBe(false);
  expect(o.paths.configDir).toBeTruthy();
  const bad = await ui(s, '/api/config', 'PUT', { budget: { alertPercent: 0 } });
  expect(bad.status).toBe(422);
  expect(bad.body).toEqual({ code: 'config.outOfRange', params: { path: 'budget.alertPercent', min: 1, max: 200 } });
  // a value inside the range that breaks the order of the trio is not an out-of-range error
  const order = await ui(s, '/api/config', 'PUT', { budget: { alertPercent: 150 } });
  expect(order.body).toEqual({ code: 'config.invalid', params: { path: 'budget.alertPercent' } });
  const many = await ui(s, '/api/config', 'PUT', { agents: { maxActivePerProject: 100000 } });
  expect(many.body).toEqual({ code: 'config.outOfRange', params: { path: 'agents.maxActivePerProject', min: 1, max: 64 } });
  expect(JSON.parse(readFileSync(configFileOf(s), 'utf8')).budget).toBeUndefined();
});
it('a dry run validates like a real patch but writes nothing', async () => {
  const p = file();
  writeFileSync(p, '{"schema":1}');
  expect(applyConfigPatch(p, { git: { testTimeoutMinutes: 30 } }, true).ok).toBe(true);
  expect(readFileSync(p, 'utf8')).toBe('{"schema":1}');
  expect(applyConfigPatch(p, { git: { testTimeoutMinutes: 9999 } }, true)).toMatchObject({ ok: false, code: 'config.invalid' });
  const s = await bootServer();
  const before = readFileSync(configFileOf(s), 'utf8');
  expect((await ui(s, '/api/config?dryRun=1', 'PUT', { agents: { maxActiveGlobal: 2 } })).status).toBe(200);
  expect((await ui(s, '/api/state')).body.limits.max).not.toBe(2);
  expect(readFileSync(configFileOf(s), 'utf8')).toBe(before);
});
