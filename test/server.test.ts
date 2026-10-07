import { it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../src/server/index';
import type { Runner } from '../src/server/prereq/checks';

const fixture = join(__dirname, 'fixtures', 'fake-agent.cjs').replace(/\\/g, '/');
type Running = Awaited<ReturnType<typeof startServer>>;
const running: Running[] = [];
afterEach(async () => { while (running.length) await running.pop()!.close(); });

const goodRunner: Runner = async (cmd) => ({
  code: 0, stdout: cmd === 'node' ? 'v24.15.0' : cmd === 'git' ? 'git version 2.53.0' : '2.1.289 (Claude Code)',
});

const lastDirs: { configDir: string; projectRoot: string } = { configDir: '', projectRoot: '' };
async function boot(runner: Runner = goodRunner, seed: { configJson?: string; agentsJson?: string; projectName?: string; i18nDir?: string } = {}): Promise<Running> {
  const configDir = mkdtempSync(join(tmpdir(), 'srv-cfg-'));
  const projectRoot = mkdtempSync(join(tmpdir(), 'srv-project-'));
  if (seed.configJson !== undefined) writeFileSync(join(configDir, 'config.json'), seed.configJson);
  if (seed.agentsJson !== undefined) {
    mkdirSync(join(projectRoot, '.console', 'state'), { recursive: true });
    writeFileSync(join(projectRoot, '.console', 'project.json'), JSON.stringify({ name: 'shop-api', createdAt: '2026-01-01T00:00:00Z' }));
    writeFileSync(join(projectRoot, '.console', 'state', 'agents.json'), seed.agentsJson);
  }
  Object.assign(lastDirs, { configDir, projectRoot });
  const s = await startServer({
    prereqRunner: runner,
    port: 0,
    projectRoot,
    configDir,
    projectName: seed.projectName ?? 'shop-api',
    i18nDir: seed.i18nDir,
    claudeCommand: [process.execPath, fixture],
    worktrees: false, // these tests use a plain temporary folder
  });
  running.push(s);
  return s;
}

interface Res { status: number; body: any }
function request(s: Running, path: string, o: { method?: string; token?: string | null; host?: string; body?: unknown } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: o.host ?? `127.0.0.1:${s.port}` };
    if (o.token !== null) headers.authorization = `Bearer ${o.token ?? s.token}`;
    let payload: string | undefined;
    if (o.body !== undefined) { payload = JSON.stringify(o.body); headers['content-type'] = 'application/json'; }
    const req = http.request({ host: '127.0.0.1', port: s.port, path, method: o.method ?? 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { let body: any = data; try { body = JSON.parse(data); } catch { /* not json */ } resolve({ status: res.statusCode ?? 0, body }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function wsOpen(s: Running, path: string, o: { origin?: string | null; token?: string | null } = {}): Promise<{ ws?: WebSocket; status?: number; box: { text: string } }> {
  return new Promise((resolve) => {
    const q = o.token === null ? '' : `?token=${o.token ?? s.token}`;
    const headers: Record<string, string> = {};
    if (o.origin !== null) headers.origin = o.origin ?? `http://127.0.0.1:${s.port}`;
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}${path}${q}`, { headers });
    // Listen from the start: the server sends the scrollback snapshot right at upgrade.
    const box = { text: '' };
    ws.on('message', (d, isBinary) => { if (isBinary) box.text += d.toString(); });
    ws.on('open', () => resolve({ ws, box }));
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode, box }));
    ws.on('error', () => { /* handled through unexpected-response or close */ });
    ws.on('close', () => resolve({ box }));
  });
}

const until = async (f: () => boolean | Promise<boolean>, ms = 8000) => {
  const t = Date.now();
  while (!(await f())) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 30));
  }
};

it('listens on 127.0.0.1 only', async () => {
  const s = await boot();
  expect(s.address).toBe('127.0.0.1');
});
it('refuses requests without the token', async () => {
  const s = await boot();
  const r = await request(s, '/api/state', { token: null });
  expect(r.status).toBe(401);
  expect(r.body).toEqual({ code: 'unauthorized' });
});
it('refuses a wrong token', async () => {
  const s = await boot();
  expect((await request(s, '/api/state', { token: 'nope' })).status).toBe(401);
});
it('refuses a foreign Host header (DNS rebinding)', async () => {
  const s = await boot();
  expect((await request(s, '/api/state', { host: 'evil.example' })).status).toBe(403);
});
it('refuses a WebSocket with a foreign Origin even with a valid token', async () => {
  const s = await boot();
  expect((await wsOpen(s, '/ws/ui', { origin: 'https://evil.example' })).status).toBe(403);
});
it('refuses a WebSocket without Origin', async () => {
  const s = await boot();
  expect((await wsOpen(s, '/ws/ui', { origin: null })).status).toBe(403);
});
it('refuses a WebSocket without the token', async () => {
  const s = await boot();
  expect((await wsOpen(s, '/ws/ui', { token: null })).status).toBe(401);
});
it('creates the main session at start and lists it in /api/state', async () => {
  const s = await boot();
  const r = await request(s, '/api/state');
  expect(r.status).toBe(200);
  expect(r.body.project.name).toBe('shop-api');
  expect(r.body.main).toMatchObject({ slug: 'shop-api', role: 'main', status: 'running' });
  expect(r.body.agents).toEqual([]);
});
it('rejects a generic slug with a code and params, and does not spawn', async () => {
  const s = await boot();
  const r = await request(s, '/api/agents', { method: 'POST', body: { slug: 'agent-1', profile: 'backend' } });
  expect(r.status).toBe(422);
  expect(r.body).toEqual({ code: 'slug.generic', params: { slug: 'agent-1' } });
  expect((await request(s, '/api/state')).body.agents).toEqual([]);
});
it('rejects a slug equal to the project name (it is the main session)', async () => {
  const s = await boot();
  const r = await request(s, '/api/agents', { method: 'POST', body: { slug: 'shop-api', profile: 'backend' } });
  expect(r.body.code).toBe('slug.duplicate');
});
it('rejects an unknown profile', async () => {
  const s = await boot();
  const r = await request(s, '/api/agents', { method: 'POST', body: { slug: 'fix-login', profile: 'wizard' } });
  expect(r.status).toBe(422);
  expect(r.body.code).toBe('profile.invalid');
});
it('accepts a valid slug, spawns, and rejects the same slug again as duplicate', async () => {
  const s = await boot();
  const a = await request(s, '/api/agents', { method: 'POST', body: { slug: 'attività-login', profile: 'backend' } });
  expect(a.status).toBe(201);
  expect(a.body).toEqual({ slug: 'attivita-login' });
  const state = (await request(s, '/api/state')).body;
  expect(state.agents.map((x: any) => [x.slug, x.status])).toEqual([['attivita-login', 'running']]);
  const b = await request(s, '/api/agents', { method: 'POST', body: { slug: 'attivita-login', profile: 'backend' } });
  expect(b.status).toBe(422);
  expect(b.body.code).toBe('slug.duplicate');
});
it('replays scrollback to a new terminal socket after the first one closed, and the process keeps running', async () => {
  const s = await boot();
  const first = await wsOpen(s, '/ws/term/shop-api');
  expect(first.ws).toBeDefined();
  const seen = first.box;
  await until(() => seen.text.includes('READY shop-api'));
  first.ws!.send(Buffer.from('hello\r'));
  await until(() => seen.text.includes('ECHO:hello'));
  first.ws!.close();
  await new Promise((r) => setTimeout(r, 200));
  expect((await request(s, '/api/state')).body.main.status).toBe('running');
  const second = await wsOpen(s, '/ws/term/shop-api');
  const replay = second.box;
  await until(() => replay.text.includes('ECHO:hello'));
  second.ws!.close();
});
it('refuses a terminal socket for an unknown session', async () => {
  const s = await boot();
  expect((await wsOpen(s, '/ws/term/ghost-job')).status).toBe(404);
});
it('serves i18n bundles with the English fallback', async () => {
  const s = await boot();
  const r = await request(s, '/i18n/it');
  expect(r.status).toBe(200);
  expect(r.body.lang).toBe('it');
  expect(r.body.messages['panel.badge.activeInput']).toBe('INPUT ATTIVO');
  expect(r.body.fallback['panel.badge.activeInput']).toBe('ACTIVE INPUT');
  expect((await request(s, '/i18n/xx')).status).toBe(404);
});
it('pushes state over /ws/ui when an agent is added', async () => {
  const s = await boot();
  const { ws } = await wsOpen(s, '/ws/ui');
  const states: any[] = [];
  ws!.on('message', (d) => states.push(JSON.parse(d.toString())));
  await request(s, '/api/agents', { method: 'POST', body: { slug: 'fix-login', profile: 'backend' } });
  await until(() => states.some((m) => m.type === 'state' && m.agents.length === 1));
  ws!.close();
});
it('exposes the terminal snapshot only when CONSOLE_TEST is set', async () => {
  const s = await boot();
  expect((await request(s, '/api/debug/snapshot/shop-api')).status).toBe(404);
});

it('includes the prerequisite results in the state once the startup checks finish', async () => {
  const s = await boot();
  await until(async () => (await request(s, '/api/state')).body.prereq !== null);
  const st = (await request(s, '/api/state')).body;
  expect(st.prereq.map((c: any) => [c.id, c.status])).toEqual([['node', 'ok'], ['git', 'ok'], ['claude', 'ok'], ['gh', 'ok']]);
});
it('blocks agent creation when a required tool is missing, with a code and the tool name', async () => {
  const missingGit: Runner = async (cmd, a, t) => {
    if (cmd === 'git') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return goodRunner(cmd, a, t);
  };
  const s = await boot(missingGit);
  await until(async () => (await request(s, '/api/state')).body.prereq !== null);
  const r = await request(s, '/api/agents', { method: 'POST', body: { slug: 'fix-login', profile: 'backend' } });
  expect(r.status).toBe(422);
  expect(r.body).toEqual({ code: 'prereq.blocked', params: { tool: 'git' } });
});
it('re-runs the checks on demand', async () => {
  let gitOk = false;
  const flaky: Runner = async (cmd, a, t) => {
    if (cmd === 'git' && !gitOk) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return goodRunner(cmd, a, t);
  };
  const s = await boot(flaky);
  await until(async () => (await request(s, '/api/state')).body.prereq !== null);
  gitOk = true;
  const r = await request(s, '/api/prereq/recheck', { method: 'POST' });
  expect(r.status).toBe(200);
  expect(r.body.find((c: any) => c.id === 'git').status).toBe('ok');
  const created = await request(s, '/api/agents', { method: 'POST', body: { slug: 'fix-login', profile: 'backend' } });
  expect(created.status).toBe(201);
});
it('reports first run until the language is saved, then keeps it', async () => {
  const s = await boot();
  expect((await request(s, '/api/state')).body.needsSetup).toBe(true);
  const bad = await request(s, '/api/config', { method: 'PUT', body: { language: 'klingon' } });
  expect(bad.status).toBe(422);
  expect(bad.body.code).toBe('config.invalid');
  const ok = await request(s, '/api/config', { method: 'PUT', body: { language: 'it' } });
  expect(ok.status).toBe(200);
  const st = (await request(s, '/api/state')).body;
  expect(st.language).toBe('it');
  expect(st.needsSetup).toBe(false);
});
it('says whether the project folder is a git repository', async () => {
  const s = await boot();
  expect((await request(s, '/api/state')).body.projectIsRepo).toBe(false);
});

it('waits for the startup checks instead of creating an agent while prerequisites are unknown (P7)', async () => {
  const slowMissingGit: Runner = async (cmd, a, t) => {
    await new Promise((r) => setTimeout(r, 400));
    if (cmd === 'git') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return goodRunner(cmd, a, t);
  };
  const s = await boot(slowMissingGit);
  const r = await request(s, '/api/agents', { method: 'POST', body: { slug: 'fix-login', profile: 'backend' } });
  expect(r.status).toBe(422);
  expect(r.body).toEqual({ code: 'prereq.blocked', params: { tool: 'git' } });
});
it('saving the language keeps every other entry of a hand-edited config', async () => {
  const original = { language: 'auto', claude: { command: ['C:/tools/claude.exe'] }, agents: { bypassPermissions: true }, custom: { keep: 1 } };
  const s = await boot(goodRunner, { configJson: JSON.stringify(original) });
  expect((await request(s, '/api/config', { method: 'PUT', body: { language: 'it' } })).status).toBe(200);
  const saved = JSON.parse(readFileSync(join(lastDirs.configDir, 'config.json'), 'utf8'));
  expect(saved).toMatchObject({ language: 'it', claude: { command: ['C:/tools/claude.exe'] }, agents: { bypassPermissions: true }, custom: { keep: 1 } });
});
it('refuses to overwrite a config file it cannot read, and leaves it untouched', async () => {
  const broken = '{"language": "it",}';
  const s = await boot(goodRunner, { configJson: broken });
  const r = await request(s, '/api/config', { method: 'PUT', body: { language: 'en' } });
  expect(r.status).toBe(409);
  expect(r.body.code).toBe('config.unreadable');
  expect(readFileSync(join(lastDirs.configDir, 'config.json'), 'utf8')).toBe(broken);
});
it('lists only sessions of this run: agents saved by an earlier run do not take panel slots, but keep their slug reserved', async () => {
  const old = JSON.stringify([{ slug: 'old-job', profile: 'backend', createdAt: '2026-01-01T00:00:00Z' }]);
  const s = await boot(goodRunner, { agentsJson: old });
  expect((await request(s, '/api/state')).body.agents).toEqual([]);
  expect((await request(s, '/api/agents', { method: 'POST', body: { slug: 'old-job', profile: 'backend' } })).body.code).toBe('slug.duplicate');
  expect((await request(s, '/api/agents', { method: 'POST', body: { slug: 'new-job', profile: 'backend' } })).status).toBe(201);
  expect((await request(s, '/api/state')).body.agents.map((a: any) => a.slug)).toEqual(['new-job']);
});

it('survives a corrupt agents.json: the state still loads and the UI socket opens', async () => {
  const s = await boot(goodRunner, { agentsJson: '{}' });
  const st = await request(s, '/api/state');
  expect(st.status).toBe(200);
  expect(st.body.agents).toEqual([]);
  expect((await wsOpen(s, '/ws/ui')).ws).toBeDefined();
});
it('refuses a malformed WebSocket request instead of crashing the process', async () => {
  const s = await boot();
  const status = await new Promise<number>((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, path: '//[', headers: { host: `127.0.0.1:${s.port}`, connection: 'Upgrade', upgrade: 'websocket', origin: `http://127.0.0.1:${s.port}`, 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
    req.on('response', (res) => resolve(res.statusCode ?? 0));
    req.on('upgrade', () => resolve(101));
    req.on('error', () => resolve(0));
    req.end();
  });
  expect([400, 401, 404, 0]).toContain(status);
  expect((await request(s, '/api/state')).status).toBe(200); // still alive
});
it('offers every language that has a bundle file, and saves it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'i18n-'));
  cpSync(join(__dirname, '..', 'src', 'i18n'), dir, { recursive: true });
  writeFileSync(join(dir, 'messages_fr.properties'), readFileSync(join(dir, 'messages_en.properties'), 'utf8'));
  const s = await boot(goodRunner, { i18nDir: dir });
  expect((await request(s, '/api/state')).body.languages).toEqual(['en', 'fr', 'it']);
  expect((await request(s, '/api/config', { method: 'PUT', body: { language: 'fr' } })).status).toBe(200);
  expect((await request(s, '/api/config', { method: 'PUT', body: { language: 'xx' } })).status).toBe(422);
  expect((await request(s, '/i18n/fr')).status).toBe(200);
});
it('cleans up when saving the new agent fails after the process started, so the slug can be retried', async () => {
  const s = await boot();
  const file = join(lastDirs.projectRoot, '.console', 'state', 'agents.json');
  const original = readFileSync(file, 'utf8');
  rmSync(file);
  mkdirSync(file); // a directory where the file should be: writing fails
  const failed = await request(s, '/api/agents', { method: 'POST', body: { slug: 'retry-job', profile: 'backend' } });
  expect(failed.status).toBe(500);
  expect(failed.body.code).toBe('agent.spawnFailed');
  expect((await request(s, '/api/state')).body.agents).toEqual([]);
  rmSync(file, { recursive: true });
  writeFileSync(file, original);
  const retried = await request(s, '/api/agents', { method: 'POST', body: { slug: 'retry-job', profile: 'backend' } });
  expect(retried.status).toBe(201);
});
it('keeps the project name stored in project.json even if the folder was renamed to something else', async () => {
  const old = JSON.stringify([{ slug: 'old-job', profile: 'backend', createdAt: '2026-01-01T00:00:00Z' }]);
  const s = await boot(goodRunner, { agentsJson: old, projectName: 'old-job' });
  const st = (await request(s, '/api/state')).body;
  expect(st.project.name).toBe('shop-api');
  expect(st.main.slug).toBe('shop-api');
});

it('serves the splash image without a token, as a real JPEG', async () => {
  const s = await boot();
  const r = await fetch(`http://127.0.0.1:${s.port}/splash.jpg`);
  expect(r.status).toBe(200);
  expect(r.headers.get('content-type')).toBe('image/jpeg');
  const bytes = new Uint8Array(await r.arrayBuffer());
  expect(bytes.length).toBeGreaterThan(10_000);
  expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
});

it('serves the page with the build version in the tab title and over the splash', async () => {
  const s = await boot();
  const html = await (await fetch(`http://127.0.0.1:${s.port}/`)).text();
  expect(html).toMatch(/<title>AndromedaCli v\d+\.\d+\.\d+[^<]*<\/title>/);
  expect(html).toMatch(/<span id="splash-version">v\d+\.\d+\.\d+[^<]*<\/span>/);
  expect(html).not.toContain('%VERSION%');
});
