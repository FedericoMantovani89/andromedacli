import { it, expect } from 'vitest';
import { runChecks, type Runner } from '../src/server/prereq/checks';
import { runDoctor } from '../src/server/prereq/doctor';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ok: Runner = async (cmd) => ({
  code: 0, stdout: cmd === 'node' ? 'v24.15.0' : cmd === 'git' ? 'git version 2.53.0' : cmd === 'gh' ? 'gh version 2.40.0 (2023-12-13)' : '2.1.289 (Claude Code)',
});

it('checks gh as an optional tool and reads its version', async () => {
  const gh = (await runChecks(ok)).find((c) => c.id === 'gh')!;
  expect(gh).toMatchObject({ id: 'gh', required: false, status: 'ok', version: '2.40.0' });
});

it('a missing gh is "missing" and optional, never an error and never required', async () => {
  const run: Runner = async (cmd, a, t) => {
    if (cmd === 'gh') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return ok(cmd, a, t);
  };
  const results = await runChecks(run);
  expect(results.find((c) => c.id === 'gh')).toMatchObject({ status: 'missing', required: false });
  expect(results.filter((c) => c.required).every((c) => c.status === 'ok')).toBe(true);
});

it('the doctor warns about a missing gh but still passes', async () => {
  const run: Runner = async (cmd, a, t) => {
    if (cmd === 'gh') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return ok(cmd, a, t);
  };
  const r = await runDoctor({ configDir: mkdtempSync(join(tmpdir(), 'gh-cfg-')), planRoot: mkdtempSync(join(tmpdir(), 'gh-plan-')), run });
  expect(r.checks.find((c) => c.id === 'gh')).toMatchObject({ status: 'warn' });
  expect(r.ok).toBe(true);
}, 60_000);
