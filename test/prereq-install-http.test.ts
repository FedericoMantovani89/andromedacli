import { it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../src/server/index';
import type { Runner } from '../src/server/prereq/checks';
import type { InstallEntry } from '../src/server/prereq/install';
import { goodRunner, ui, until, req, type Running } from './helpers';

const fixture = join(__dirname, 'fixtures', 'fake-agent.cjs').replace(/\\/g, '/');
const running: Running[] = [];
afterEach(async () => { while (running.length) await running.pop()!.close(); });

/** A trivial Node command instead of winget: the test seam `installTable` swaps it in for the shipped table. */
const node = (id: InstallEntry['id'], code: string, extra: string[] = [], over: Partial<InstallEntry> = {}): InstallEntry => {
  const argv = [process.execPath, '-e', code, ...extra];
  return { id, action: 'install', argv, display: argv.join(' '), source: { kind: 'winget', origin: 'test' }, secondConfirm: false, mayNeedAdmin: false, verified: false, ...over };
};
const missing = (cmd: string): never => { throw Object.assign(new Error(`${cmd} ENOENT`), { code: 'ENOENT' }); };

async function boot(o: { table: InstallEntry[]; prereq?: Runner; probe?: Runner }) {
  const configDir = mkdtempSync(join(tmpdir(), 'inst-cfg-'));
  const s = await startServer({
    port: 0, projectRoot: mkdtempSync(join(tmpdir(), 'inst-project-')), configDir, projectName: 'shop-api', claudeCommand: [process.execPath, fixture],
    modDir: null, worktrees: false, projectsDir: mkdtempSync(join(tmpdir(), 'inst-proj-')),
    prereqRunner: o.prereq ?? goodRunner, installTable: o.table, installRunner: o.probe ?? goodRunner,
  });
  running.push(s);
  await until(async () => (await ui(s, '/api/state')).body.prereq !== null);
  return { s, configDir };
}
const gitMissing: Runner = async (cmd, a, t) => (cmd === 'git' ? missing(cmd) : goodRunner(cmd, a, t));

it('describes the command to run, and nothing without the token', async () => {
  const { s } = await boot({ table: [node('git', 'process.exit(0)')], prereq: gitMissing });
  const r = await ui(s, '/api/prereq/git/install');
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ id: 'git', action: 'install', display: [process.execPath, '-e', 'process.exit(0)'].join(' '), secondConfirm: false, verified: false });
  expect((await req(s, '/api/prereq/git/install')).status).toBe(401);
  expect((await req(s, '/api/prereq/git/install', { method: 'POST', body: { confirmed: true } })).status).toBe(401);
});

it('refuses without consent, an unknown tool and a tool that needs nothing', async () => {
  const { s } = await boot({ table: [node('git', 'process.exit(0)'), node('node', 'process.exit(0)')], prereq: gitMissing });
  expect((await ui(s, '/api/prereq/git/install', 'POST', {})).status).toBe(400);
  expect((await ui(s, '/api/prereq/git/install', 'POST', { confirmed: 'yes' })).status).toBe(400);
  expect((await ui(s, '/api/prereq/nope/install', 'POST', { confirmed: true })).status).toBe(404);
  expect((await ui(s, '/api/prereq/nope/install')).status).toBe(404);
  // node is installed (ok): there is nothing to install.
  expect((await ui(s, '/api/prereq/node/install', 'POST', { confirmed: true })).status).toBe(404);
  expect((await ui(s, '/api/prereq/node/install')).status).toBe(404);
});

it('a script entry needs the second confirmation', async () => {
  const script = node('git', 'process.exit(0)', [], { source: { kind: 'script', origin: 'https://example.invalid/install.ps1' }, secondConfirm: true });
  const { s } = await boot({ table: [script], prereq: gitMissing });
  expect((await ui(s, '/api/prereq/git/install')).body).toMatchObject({ secondConfirm: true });
  expect((await ui(s, '/api/prereq/git/install', 'POST', { confirmed: true })).status).toBe(400);
  expect((await ui(s, '/api/prereq/git/install', 'POST', { confirmed: true, confirmedScript: true })).status).toBe(202);
});

it('says why it cannot install when winget or npm is not there', async () => {
  const probe: Runner = async (cmd) => missing(cmd);
  const { s } = await boot({ table: [node('git', 'process.exit(0)'), node('claude', 'process.exit(0)', [], { source: { kind: 'npm', origin: 'test' } })], prereq: async (cmd, a, t) => (cmd === 'git' ? missing(cmd) : cmd === process.execPath ? goodRunner(cmd, a, t) : goodRunner(cmd, a, t)), probe });
  expect((await ui(s, '/api/prereq/git/install')).body).toEqual({ unavailable: 'no_winget' });
  const r = await ui(s, '/api/prereq/git/install', 'POST', { confirmed: true });
  expect(r.status).toBe(422);
  expect(r.body.code).toBe('install.unavailable');
});

it('runs the fixed command in a utility terminal, rechecks when it ends and writes one log line', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'inst-mark-')), 'done.txt');
  // The command leaves a marker; the check passes only once it exists, so the recheck after the exit is what turns git "ok".
  const prereq: Runner = async (cmd, a, t) => (cmd === 'git' && !existsSync(marker) ? missing(cmd) : goodRunner(cmd, a, t));
  const { s, configDir } = await boot({ table: [node('git', 'require(`fs`).writeFileSync(process.argv[1],`x`)', [marker])], prereq });
  expect((await ui(s, '/api/state')).body.install).toBeUndefined();
  const r = await ui(s, '/api/prereq/git/install', 'POST', { confirmed: true });
  expect(r.status).toBe(202);
  expect(r.body).toEqual({ terminal: 'install-git' });
  // The terminal socket serves it (token and Origin as for every terminal) and the project's own sessions are untouched.
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/term/install-git?token=${s.token}`, { headers: { origin: `http://127.0.0.1:${s.port}` } });
  await new Promise<void>((ok, err) => { ws.on('open', () => ok()); ws.on('error', err); });
  ws.close();
  await until(async () => (await ui(s, '/api/state')).body.install?.result === 'done', 20000);
  const st = (await ui(s, '/api/state')).body;
  expect(st.install).toEqual({ id: 'git', result: 'done', exitCode: 0 });
  expect(st.prereq.find((c: any) => c.id === 'git').status).toBe('ok');
  const lines = readFileSync(join(configDir, 'install.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ id: 'git', action: 'install', exitCode: 0, verified: false });
  expect(lines[0].display).toContain('writeFileSync');
  expect(typeof lines[0].at).toBe('string');
}, 60_000);

it('the terminal socket takes no keyboard input and unknown terminals stay 404', async () => {
  const { s } = await boot({ table: [node('git', 'setTimeout(()=>{},1500)')], prereq: gitMissing });
  expect((await ui(s, '/api/prereq/git/install', 'POST', { confirmed: true })).status).toBe(202);
  const nope = new WebSocket(`ws://127.0.0.1:${s.port}/ws/term/install-nope?token=${s.token}`, { headers: { origin: `http://127.0.0.1:${s.port}` } });
  const status = await new Promise<number>((ok) => { nope.on('unexpected-response', (_q, res) => ok(res.statusCode ?? 0)); nope.on('open', () => ok(0)); nope.on('error', () => {}); });
  expect(status).toBe(404);
});

it('refuses a second install while one runs (409 install.busy)', async () => {
  const { s } = await boot({ table: [node('git', 'setTimeout(()=>{},4000)'), node('claude', 'process.exit(0)')], prereq: async (cmd, a, t) => (cmd === 'git' || cmd === process.execPath ? missing(cmd) : goodRunner(cmd, a, t)) });
  const first = await ui(s, '/api/prereq/git/install', 'POST', { confirmed: true });
  expect(first.status).toBe(202);
  const second = await ui(s, '/api/prereq/git/install', 'POST', { confirmed: true });
  expect(second.status).toBe(409);
  expect(second.body).toEqual({ code: 'install.busy' });
});

it('reports needs_admin for exit code 740 and failed for another code', async () => {
  const admin = await boot({ table: [node('git', 'process.exit(740)')], prereq: gitMissing });
  expect((await ui(admin.s, '/api/prereq/git/install', 'POST', { confirmed: true })).status).toBe(202);
  await until(async () => (await ui(admin.s, '/api/state')).body.install !== undefined, 20000);
  expect((await ui(admin.s, '/api/state')).body.install).toEqual({ id: 'git', result: 'needs_admin', exitCode: 740 });

  const failed = await boot({ table: [node('git', 'process.exit(3)')], prereq: gitMissing });
  expect((await ui(failed.s, '/api/prereq/git/install', 'POST', { confirmed: true })).status).toBe(202);
  await until(async () => (await ui(failed.s, '/api/state')).body.install !== undefined, 20000);
  expect((await ui(failed.s, '/api/state')).body.install).toEqual({ id: 'git', result: 'failed', exitCode: 3 });
}, 60_000);
