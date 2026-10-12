import { it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server/index';
import type { Runner } from '../src/server/prereq/checks';

const fixture = join(__dirname, 'fixtures', 'fake-agent.cjs').replace(/\\/g, '/');
type Running = Awaited<ReturnType<typeof startServer>>;
const running: Running[] = [];
afterEach(async () => { while (running.length) await running.pop()!.close(); });

const goodRunner: Runner = async (cmd) => ({
  code: 0, stdout: cmd === 'node' ? 'v24.15.0' : cmd === 'git' ? 'git version 2.53.0' : '2.1.289 (Claude Code)',
});

async function boot(runner: Runner = goodRunner): Promise<Running> {
  const configDir = mkdtempSync(join(tmpdir(), 'srv-cfg-'));
  const projectRoot = mkdtempSync(join(tmpdir(), 'srv-project-'));
  const s = await startServer({
    prereqRunner: runner,
    port: 0,
    projectRoot,
    configDir,
    projectName: 'shop-api',
    claudeCommand: [process.execPath, fixture],
    worktrees: false, // a plain temporary folder
  });
  running.push(s);
  return s;
}

interface Res { status: number; body: any }
function request(s: Running, path: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${s.port}`, authorization: `Bearer ${s.token}` };
    const req = http.request({ host: '127.0.0.1', port: s.port, path, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { let body: any = data; try { body = JSON.parse(data); } catch { /* not json */ } resolve({ status: res.statusCode ?? 0, body }); });
    });
    req.on('error', reject);
    req.end();
  });
}

// Characterization: this shape is what the page reads; every step of the composition-root refactor must keep it.
it('a project assembled by startServer exposes this state, and starts and stops cleanly', async () => {
  const s = await boot(goodRunner);
  const state = (await request(s, '/api/state')).body;
  expect(Object.keys(state).sort()).toMatchInlineSnapshot(`
    [
      "agents",
      "helperUse",
      "language",
      "languages",
      "limits",
      "main",
      "needsSetup",
      "notifications",
      "prereq",
      "profiles",
      "project",
      "projectIsRepo",
      "projectRoot",
      "projects",
      "queue",
      "repos",
      "settings",
      "type",
    ]
  `);
  expect(state.main).toMatchObject({ slug: 'shop-api', role: 'main' });
  expect((await request(s, '/api/options')).status).toBe(200);
  await s.close();
  running.pop();
});
