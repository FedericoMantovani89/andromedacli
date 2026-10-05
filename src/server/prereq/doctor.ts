import http from 'node:http';
import { mkdtempSync, rmSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { loadConfig } from '../config';
import { loadBundles } from '../i18n-bundles';
import { startServer } from '../index';
import { checkBundles } from '../../shared/i18n-checks';
import { runChecks, type CheckResult, type Runner } from './checks';

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'error';
export interface DoctorCheck { id: string; status: DoctorStatus; detail?: string; fix?: string }
export interface DoctorReport { ok: boolean; checks: DoctorCheck[] }

const FIX: Record<CheckResult['id'], string> = {
  node: 'Install Node.js 22 or newer: winget install OpenJS.NodeJS.LTS',
  git: 'Install Git for Windows: winget install Git.Git',
  claude: 'Install or update Claude Code (2.1.287 or newer): https://code.claude.com/docs',
  gh: 'Optional, only for pull requests. Install the GitHub CLI: winget install GitHub.cli',
};
const MIN_FREE_BYTES = 2 * 1024 ** 3;

function fromPrereq(c: CheckResult): DoctorCheck {
  const detail = [c.version, c.message].filter(Boolean).join(' ') || undefined;
  if (c.status === 'ok') return { id: c.id, status: 'ok', detail };
  if (c.status === 'error') return { id: c.id, status: 'error', detail, fix: 'Run the command by hand to see why it fails.' };
  return { id: c.id, status: c.required ? 'fail' : 'warn', detail: detail ?? c.status, fix: FIX[c.id] };
}

function httpStatus(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
}

function wsRefusal(port: number, token: string, origin: string): Promise<number | 'opened'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/ui?token=${token}`, { headers: { origin } });
    ws.on('open', () => { ws.close(); resolve('opened'); });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => {});
  });
}

/** SPEC 4.5 / 29.6: starts a throw-away server and proves the token, Host and Origin checks and the loopback bind. */
async function securitySelfTest(): Promise<DoctorCheck> {
  const planRoot = mkdtempSync(join(tmpdir(), 'doctor-plan-'));
  const configDir = mkdtempSync(join(tmpdir(), 'doctor-cfg-'));
  const server = await startServer({
    port: 0, planRoot, configDir,
    planName: 'doctor-probe', claudeCommand: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'],
  });
  try {
    const own = `127.0.0.1:${server.port}`;
    const problems: string[] = [];
    if (server.address !== '127.0.0.1') problems.push(`bound to ${server.address}`);
    if ((await httpStatus(server.port, '/api/state', { host: own })) !== 401) problems.push('request without token was not refused');
    if ((await httpStatus(server.port, '/api/state', { host: 'evil.example', authorization: `Bearer ${server.token}` })) !== 403) problems.push('foreign Host was not refused');
    if ((await wsRefusal(server.port, server.token, 'https://evil.example')) !== 403) problems.push('foreign Origin was not refused');
    if ((await wsRefusal(server.port, server.token, `http://${own}`)) !== 'opened') problems.push('legitimate WebSocket was refused');
    return problems.length === 0
      ? { id: 'server.security', status: 'ok', detail: 'loopback only; token, Host and Origin checks active' }
      : { id: 'server.security', status: 'fail', detail: problems.join('; '), fix: 'Do not use the console until this passes; report the failure.' };
  } finally {
    await server.close();
    rmSync(planRoot, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
}

/** Read-only health checks of what Phase 1 has built (the rest of SPEC 29.6 arrives with the phases that build it). */
export async function runDoctor(o: { configDir: string; planRoot: string; run?: Runner }): Promise<DoctorReport> {
  const loaded = loadConfig(join(o.configDir, 'config.json'));
  const checks: DoctorCheck[] = (await runChecks(o.run, { claudeCommand: loaded.config.claude.command })).map(fromPrereq);

  try { checks.push(await securitySelfTest()); }
  catch (e) { checks.push({ id: 'server.security', status: 'error', detail: e instanceof Error ? e.message : String(e) }); }

  const { errors } = loaded;
  checks.push(errors.length === 0
    ? { id: 'config', status: 'ok' }
    : { id: 'config', status: 'warn', detail: errors.map((e) => e.path || e.code).join(', '), fix: 'Fix or delete the listed entries; defaults are used meanwhile.' });

  const bundles: Record<string, Record<string, string>> = Object.fromEntries(loadBundles());
  const parity = checkBundles(bundles, new Set(Object.keys(bundles.en ?? {})), []);
  checks.push(parity.length === 0 ? { id: 'i18n', status: 'ok' } : { id: 'i18n', status: 'fail', detail: parity.join('; '), fix: 'Add the missing keys to the language files.' });

  try {
    const s = statfsSync(o.planRoot);
    const free = s.bavail * s.bsize;
    checks.push(free >= MIN_FREE_BYTES
      ? { id: 'disk', status: 'ok', detail: `${Math.round(free / 1024 ** 3)} GiB free` }
      : { id: 'disk', status: 'warn', detail: `${Math.round(free / 1024 ** 2)} MiB free`, fix: 'Free some disk space: agent worktrees need room.' });
  } catch (e) {
    checks.push({ id: 'disk', status: 'error', detail: e instanceof Error ? e.message : String(e) });
  }

  return { ok: !checks.some((c) => c.status === 'fail' || c.status === 'error'), checks };
}
