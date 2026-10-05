import { it, expect } from 'vitest';
import { runChecks, compareVersions, type Runner } from '../src/server/prereq/checks';

type Row = { code: number; stdout: string } | 'enoent' | 'timeout';
const fake = (table: Record<string, Row>): Runner => async (cmd) => {
  const r = table[cmd];
  if (r === 'enoent') throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  if (r === 'timeout') throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
  return r ?? { code: 1, stdout: '' };
};

it('compares dotted versions numerically', () => {
  expect(compareVersions('2.1.289', '2.1.287')).toBeGreaterThan(0);
  expect(compareVersions('2.1.9', '2.1.10')).toBeLessThan(0);
  expect(compareVersions('22.0.0', '22')).toBe(0);
});
it('reports ok with versions parsed from each tool', async () => {
  const r = await runChecks(fake({
    node: { code: 0, stdout: 'v24.15.0' }, git: { code: 0, stdout: 'git version 2.53.0.windows.3' },
    claude: { code: 0, stdout: '2.1.289 (Claude Code)' }, gh: { code: 0, stdout: 'gh version 2.40.0 (2023-12-13)' },
  }));
  expect(r.map((c) => [c.id, c.status, c.version])).toEqual([['node', 'ok', '24.15.0'], ['git', 'ok', '2.53.0'], ['claude', 'ok', '2.1.289'], ['gh', 'ok', '2.40.0']]);
  expect(r.filter((c) => c.required).map((c) => c.id)).toEqual(['node', 'git', 'claude']);
});
it('flags Claude Code below 2.1.287 and Node below 22 as outdated', async () => {
  const r = await runChecks(fake({
    node: { code: 0, stdout: 'v20.1.0' }, git: { code: 0, stdout: 'git version 2.40.0' },
    claude: { code: 0, stdout: '2.1.250 (Claude Code)' },
  }));
  expect(r.find((c) => c.id === 'claude')?.status).toBe('outdated');
  expect(r.find((c) => c.id === 'node')?.status).toBe('outdated');
});
it('reports missing for ENOENT and error (never ok) when a check cannot produce a result', async () => {
  const r = await runChecks(fake({ node: { code: 0, stdout: 'v24.15.0' }, git: 'enoent', claude: 'timeout' }));
  expect(r.find((c) => c.id === 'git')?.status).toBe('missing');
  const claude = r.find((c) => c.id === 'claude');
  expect(claude?.status).toBe('error');
  expect(claude?.message).toBeTruthy();
});
it('treats garbage output and a failing exit code as error, not ok', async () => {
  const r = await runChecks(fake({
    node: { code: 0, stdout: 'banana' }, git: { code: 3, stdout: 'git version 2.53.0' }, claude: { code: 0, stdout: '2.1.289' },
  }));
  expect(r.find((c) => c.id === 'node')?.status).toBe('error');
  expect(r.find((c) => c.id === 'git')?.status).toBe('error');
});
it('runs the checks in parallel', async () => {
  const slow: Runner = async (cmd) => {
    await new Promise((r) => setTimeout(r, 150));
    return { code: 0, stdout: cmd === 'claude' ? '2.1.289' : cmd === 'git' ? 'git version 2.5.0' : 'v22.0.0' };
  };
  const t = Date.now();
  await runChecks(slow);
  expect(Date.now() - t).toBeLessThan(400);
});

it('checks the configured Claude command, not just whatever is on PATH', async () => {
  const calls: string[][] = [];
  const spy: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code: 0, stdout: cmd === 'node' ? 'v24.15.0' : cmd === 'git' ? 'git version 2.53.0' : '2.1.289 (Claude Code)' };
  };
  await runChecks(spy, { claudeCommand: ['C:/tools/claude.exe', '--profile', 'x'] });
  expect(calls).toContainEqual(['C:/tools/claude.exe', '--profile', 'x', '--version']);
  expect(calls.some((c) => c[0] === 'claude')).toBe(false);
});
