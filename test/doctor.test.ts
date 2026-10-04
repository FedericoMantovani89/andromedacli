import { it, expect } from 'vitest';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../src/server/prereq/doctor';
import type { Runner } from '../src/server/prereq/checks';

const goodRunner: Runner = async (cmd) => ({
  code: 0, stdout: cmd === 'node' ? 'v24.15.0' : cmd === 'git' ? 'git version 2.53.0' : '2.1.289 (Claude Code)',
});
const dirs = () => ({ configDir: mkdtempSync(join(tmpdir(), 'doc-cfg-')), planRoot: mkdtempSync(join(tmpdir(), 'doc-plan-')) });
const byId = (r: Awaited<ReturnType<typeof runDoctor>>, id: string) => r.checks.find((c) => c.id === id);

it('reports ok when everything works, including the live security self-test', async () => {
  const r = await runDoctor({ ...dirs(), run: goodRunner });
  expect(r.checks.map((c) => c.id)).toEqual(['node', 'git', 'claude', 'server.security', 'config', 'i18n', 'disk']);
  expect(byId(r, 'server.security')).toMatchObject({ status: 'ok' });
  expect(r.ok).toBe(true);
}, 40000);

it('fails with a fix hint when a required tool is missing', async () => {
  const missingClaude: Runner = async (cmd, a, t) => {
    if (cmd === 'claude') throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    return goodRunner(cmd, a, t);
  };
  const r = await runDoctor({ ...dirs(), run: missingClaude });
  expect(byId(r, 'claude')?.status).toBe('fail');
  expect(byId(r, 'claude')?.fix).toBeTruthy();
  expect(r.ok).toBe(false);
}, 40000);

it('a broken config warns but never blocks the console', async () => {
  const d = dirs();
  writeFileSync(join(d.configDir, 'config.json'), JSON.stringify({ language: 'klingon' }));
  const r = await runDoctor({ ...d, run: goodRunner });
  expect(byId(r, 'config')?.status).toBe('warn');
  expect(byId(r, 'config')?.detail).toContain('language');
  expect(r.ok).toBe(true);
}, 40000);

it('leaves no temporary folders behind after the security self-test', async () => {
  const count = () => readdirSync(tmpdir()).filter((n) => n.startsWith('doctor-')).length;
  const before = count();
  await runDoctor({ ...dirs(), run: goodRunner });
  expect(count()).toBe(before);
}, 40000);
