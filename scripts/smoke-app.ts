// `npm run smoke:app`: starts the unpacked desktop app (`npm run dist:dir` first) with a throw-away config folder and the fake agent,
// checks the window, the page, a real terminal (node-pty from the packaged files) and prints the memory the app's processes use.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { _electron as electron } from 'playwright-core';
import WebSocket from 'ws';

const root = resolve(import.meta.dirname, '..');
const exe = join(root, 'release', 'win-unpacked', 'AndromedaCli.exe');
if (!existsSync(exe)) { console.error('smoke: run `npm run dist:dir` first'); process.exit(2); }

const configDir = mkdtempSync(join(tmpdir(), 'smoke-cfg-'));
const project = mkdtempSync(join(tmpdir(), 'smoke-proj-'));
mkdirSync(join(configDir, 'state'), { recursive: true });
const fixture = join(root, 'test', 'fixtures', 'fake-agent.cjs');
// The console judges `claude` by running `<command> --version`: the stand-in answers that and otherwise behaves as the fake agent.
const fakeClaude = join(configDir, 'fake-claude.cjs');
writeFileSync(fakeClaude, `if (process.argv.includes('--version')) { console.log('2.1.289 (Claude Code)'); process.exit(0); }
require(${JSON.stringify(fixture)});
`);
writeFileSync(join(configDir, 'config.json'), JSON.stringify({ schema: 1, language: 'en', git: { worktrees: false }, claude: { command: [process.execPath, fakeClaude] }, mod: { enabled: false } }));

let failed = false;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed = true;
};

/** The private memory of each process of the app, by kind (main = the server and the window's owner). */
function perProcess(): string {
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='AndromedaCli.exe'\" | ForEach-Object { $t = if ($_.CommandLine -match '--type=([a-z-]+)') { $Matches[1] } else { 'main' }; $pr = Get-Process -Id $_.ProcessId; '{0}:{1}MB' -f $t, [math]::Round($pr.PrivateMemorySize64 / 1MB) }";
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim().split(/\r?\n/).join('  ');
}

function memory(): { processes: number; workingMb: number; privateMb: number } {
  const ps = "$p = Get-Process -Name AndromedaCli -ErrorAction SilentlyContinue; if ($p) { '{0} {1} {2}' -f $p.Count, [math]::Round(($p | Measure-Object WorkingSet64 -Sum).Sum / 1MB), [math]::Round(($p | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB) } else { '0 0 0' }";
  const [n, w, p] = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim().split(' ').map(Number);
  return { processes: n ?? 0, workingMb: w ?? 0, privateMb: p ?? 0 };
}

const fuses = await getCurrentFuseWire(exe);
check('the exe cannot be run as a plain Node interpreter (fuse RunAsNode is off)', fuses[FuseV1Options.RunAsNode] === FuseState.DISABLE);
check('NODE_OPTIONS is not read (fuse is off)', fuses[FuseV1Options.EnableNodeOptionsEnvironmentVariable] === FuseState.DISABLE);

const app = await electron.launch({ executablePath: exe, env: { ...process.env, CONSOLE_CONFIG_DIR: configDir, CONSOLE_PORT: '0', CONSOLE_TEST: '1' } });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('#topbar', { state: 'attached', timeout: 30_000 }); // hidden until a project is open
  // #topbar is in the static HTML: it is there before the page's script (a deferred module) has run, so wait until the script has taken the token.
  await page.waitForFunction(() => { try { return !!sessionStorage.getItem('console.token'); } catch { return false; } }, undefined, { timeout: 30_000 });
  const url = new URL(page.url());
  // The page keeps the token for itself and takes it out of the address bar (src/ui/api.ts).
  const token = (await page.evaluate(() => sessionStorage.getItem('console.token'))) ?? '';
  check('the window shows the console on 127.0.0.1', url.hostname === '127.0.0.1' && token !== '', page.url());
  check('the title names the app', (await page.title()).includes('AndromedaCli'), await page.title());
  check('the page has no Node.js (sandboxed, no integration)', await page.evaluate(() => typeof (globalThis as { require?: unknown }).require === 'undefined' && typeof (globalThis as { process?: unknown }).process === 'undefined'));

  const base = url.origin;
  const api = async (path: string, method = 'GET', body?: unknown): Promise<{ status: number; json: any }> => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, json: await r.json().catch(() => undefined) };
  };
  const added = await api('/api/projects', 'POST', { root: project, name: 'smoke-proj' });
  check('a project opens', added.status === 201 || added.status === 200, `status ${added.status} ${JSON.stringify(added.json)}`);
  const made = await api('/api/agents?project=smoke-proj', 'POST', { slug: 'smoke-job', profile: 'developer' });
  check('an agent starts', made.status === 201, `status ${made.status} ${JSON.stringify(made.json)}`);

  const ws = new WebSocket(`ws://${url.host}/ws/term/smoke-job?project=smoke-proj&token=${token}`, { headers: { origin: base } });
  let seen = '';
  ws.on('message', (d, binary) => { if (binary) seen += d.toString(); });
  await new Promise<void>((ok, bad) => { ws.on('open', () => ok()); ws.on('error', bad); });
  const t0 = Date.now();
  while (!seen.includes('READY smoke-job') && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 100));
  check('a real terminal runs (node-pty from the packaged files)', seen.includes('READY smoke-job'));

  await page.reload(); // the page learns of the project opened through the API
  await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 20_000 });
  await page.click('#settings-btn');
  await page.waitForSelector('.options-dialog', { timeout: 10_000 });
  check('the Options dialog opens (lazy chunk loaded)', true);
  await page.keyboard.press('Escape');

  const m = memory();
  console.log(`memory: ${m.processes} processes, working set ${m.workingMb} MB, private ${m.privateMb} MB`);
  console.log(`  by process (private): ${perProcess()}`);

  ws.send(Buffer.from('quit\r')); // the fake agent ends, so closing the window does not ask
  const t1 = Date.now();
  while (Date.now() - t1 < 10_000 && (await api('/api/state?project=smoke-proj')).json?.agents?.[0]?.status === 'running') await new Promise((r) => setTimeout(r, 200));
  ws.close();
} finally {
  await app.close().catch(() => undefined);
}
// The window closed and the agent had ended: the whole app must be gone, with no process left behind.
await new Promise((r) => setTimeout(r, 4000));
check('no process is left after closing', memory().processes === 0, `${memory().processes} left`);
process.exit(failed ? 1 : 0);
