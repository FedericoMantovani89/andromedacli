import http from 'node:http';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRequestHandler, type Context } from './http';
import { attachWebSockets } from './ws';
import { loadBundles } from './i18n-bundles';
import { loadConfig } from './config';
import { PlanStore } from './plan-store';
import { PtyManager } from './pty/pty-manager';
import { buildClaudeLaunch } from './pty/claude-launch';
import { createToken } from './security';
import { runChecks, type Runner } from './prereq/checks';
import type { PrereqResult } from '../shared/protocol';

export interface StartOptions {
  port: number;
  planRoot: string;
  configDir: string;
  planName: string;
  /** Folder with messages_<lang>.properties (default: the shipped ones; tests). */
  i18nDir?: string;
  claudeCommand?: string[];
  /** Injectable command runner for the prerequisite checks (tests). */
  prereqRunner?: Runner;
}
export interface RunningServer {
  port: number;
  address: string;
  token: string;
  url: string;
  close(): Promise<void>;
}

/** Starts the console: one HTTP+WebSocket server on 127.0.0.1, the plan store and the main session. */
export async function startServer(o: StartOptions): Promise<RunningServer> {
  const configPath = join(o.configDir, 'config.json');
  const { config } = loadConfig(configPath);
  const store = new PlanStore(o.planRoot);
  store.init(o.planName);
  // The plan keeps the name it was created with, even if its folder is renamed later (it is also the main session id).
  const planName = store.plan.name;
  const ptys = new PtyManager();
  const token = createToken();
  let port = 0;
  let broadcast = () => {};
  let prereq: PrereqResult[] | null = null;
  let language: string = config.language;
  const refreshPrereq = async (): Promise<PrereqResult[]> => {
    // The Claude check runs the configured command (not the test override), so a custom install is judged fairly.
    prereq = await runChecks(o.prereqRunner, { claudeCommand: config.claude.command });
    broadcast();
    return prereq;
  };
  let startupChecks: Promise<PrereqResult[]> | undefined;
  let planIsRepo = false;
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: o.planRoot, stdio: 'ignore', timeout: 5000 });
    planIsRepo = true;
  } catch { /* not a repository, or git is missing: the checks report the latter */ }

  const ctx: Context = {
    getPort: () => port,
    token, ptys, store,
    planName,
    planRoot: o.planRoot,
    claudeCommand: o.claudeCommand ?? config.claude.command,
    bypass: config.agents.bypassPermissions,
    get language() { return language; },
    bundles: loadBundles(o.i18nDir),
    uiDist: resolve(import.meta.dirname, '..', '..', 'dist', 'ui'),
    testMode: process.env.CONSOLE_TEST === '1',
    configPath,
    planIsRepo,
    getPrereq: () => prereq,
    ensurePrereq: () => prereq ? Promise.resolve(prereq) : (startupChecks ??= refreshPrereq()),
    refreshPrereq,
    setLanguage: (l) => { language = l; },
    needsSetup: () => !existsSync(configPath),
    broadcastState: () => broadcast(),
  };

  const server = http.createServer((req, res) => {
    void createRequestHandler(ctx)(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'internal' }));
    });
  });
  const ws = attachWebSockets(server, ctx);
  broadcast = ws.broadcastState;

  await new Promise<void>((ok, err) => {
    server.once('error', err);
    server.listen(o.port, '127.0.0.1', () => ok()); // never another interface (SPEC 4.5)
  });
  const addr = server.address() as AddressInfo;
  port = addr.port;
  const url = `http://127.0.0.1:${port}`;

  ptys.onExit(() => broadcast());
  startupChecks = refreshPrereq(); // background; unknown is null in the state and agent creation waits for it
  const launch = buildClaudeLaunch({
    command: ctx.claudeCommand, role: 'main', slug: planName, plan: planName,
    url, token, bypass: ctx.bypass, baseEnv: process.env,
  });
  ptys.spawn({ id: planName, ...launch, cwd: resolve(o.planRoot), cols: 120, rows: 30 });

  return {
    port, address: addr.address, token, url,
    close: async () => {
      await ptys.killAll();
      ws.closeAll();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
