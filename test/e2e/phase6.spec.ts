// Phase 6 acceptance (SPEC 24): a real server with fake agent processes, a recording notifier and, for the tabs, Edge.
//   1. restart with 3 agents: the main restarts at once with its session, the others are dormant and wake when needed;
//   2. a notification is raised by the server with no browser open (and is held back while the user is looking);
//   3. a project is created from a template in well under a minute and lives next to the first one.
// Run with: npx tsx test/e2e/phase6.spec.ts (after `npm run build`).
import { chromium } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

process.env.CONSOLE_TEST = '1';
const { startServer } = await import('../../src/server/index');
const { transcriptPath } = await import('../../src/server/claude-code/transcript');

const root = resolve(import.meta.dirname, '..', '..');
const fixture = join(root, 'test', 'fixtures', 'fake-agent.cjs').replace(/\\/g, '/');
let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { console.log(`PASS  ${label}`); return; }
  failures++;
  console.log(`FAIL  ${label} ${detail}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => Promise<boolean> | boolean, ms = 15000): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await f()) return true; await sleep(50); }
  return false;
}
const temps: string[] = [];
const tmp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d; };

type Server = Awaited<ReturnType<typeof startServer>>;
const servers: Server[] = [];
interface Toast { title: string; message: string; open?: string; sound: boolean }

function api(s: Server) {
  const call = async (token: string | undefined, path: string, method = 'GET', body?: unknown) => {
    const r = await fetch(`${s.url}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json: any = null;
    try { json = await r.json(); } catch { /* 204 */ }
    return { status: r.status, json };
  };
  const ui = (path: string, method = 'GET', body?: unknown) => call(s.token, path, method, body);
  const asMod = (slug: string, path: string, method = 'GET', body?: unknown) => call(s.sessionTokenFor(slug), path, method, body);
  const event = (slug: string, type: string, sessionId: string, data?: unknown) => asMod(slug, '/v1/events', 'POST', { type, sessionId, data });
  const state = async (project?: string): Promise<any> => (await ui(`/api/state${project ? `?project=${encodeURIComponent(project)}` : ''}`)).json;
  const agent = async (slug: string, project?: string): Promise<any> => (await state(project)).agents.find((a: any) => a.slug === slug);
  return { ui, asMod, event, state, agent };
}

async function boot(o: { projectRoot?: string; configDir: string; projectsDir?: string; notifier?: { available(): Promise<boolean>; notify(n: Toast): Promise<void> } }): Promise<Server> {
  const s = await startServer({
    port: 0, ...(o.projectRoot ? { projectRoot: o.projectRoot, projectName: 'shop-api' } : {}), configDir: o.configDir, claudeCommand: [process.execPath, fixture], modDir: null,
    projectsDir: o.projectsDir ?? tmp('e2e6-proj-'), ...(o.notifier ? { notifier: o.notifier } : {}),
  } as Parameters<typeof startServer>[0]);
  servers.push(s);
  s.setLimits({ global: 20, perProject: 20 });
  return s;
}
const writeConfig = (dir: string, extra: Record<string, unknown> = {}): void =>
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ schema: 1, language: 'en', git: { worktrees: false }, ...extra }));

try {
  // 1. Restart with three agents: the main resumes at once, the others are dormant and wake when opened or when work arrives.
  {
    const configDir = tmp('e2e6-cfg-');
    writeConfig(configDir);
    const projectRoot = tmp('e2e6-project-');
    const projectsDir = tmp('e2e6-proj-');
    const a = await boot({ projectRoot, configDir, projectsDir });
    const A = api(a);
    const mainSid = randomUUID();
    // Claude Code writes a transcript once the session has had a prompt; the console resumes only a session that has one.
    const transcript = transcriptPath(projectsDir, projectRoot, mainSid);
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, '');
    await A.event('shop-api', 'session.start', mainSid);
    const sids = new Map<string, string>();
    for (const name of ['one-job', 'two-job', 'three-job']) {
      const out = await A.asMod('shop-api', '/v1/tools/spawn_agent', 'POST', { name, profile: 'developer', goal: 'Do the work' });
      check(`agent ${name} started`, out.json?.status === 'started', JSON.stringify(out.json));
      await until(async () => (await A.agent(name))?.status === 'running');
      const sid = randomUUID();
      sids.set(name, sid);
      await A.event(name, 'session.start', sid);
      await A.event(name, 'turn.start', sid);
      await A.event(name, 'turn.complete', sid, {});
    }
    await sleep(1500); // the agent records are written at most once a second
    await a.close();

    const b = await boot({ projectRoot, configDir, projectsDir });
    const B = api(b);
    check('after the restart the main is running at once', await until(async () => (await B.state()).main.status === 'running'));
    const mainArgs = b.lastLaunchArgs('shop-api') ?? [];
    check('the main resumes its own session', mainArgs.includes('--resume') && mainArgs.includes(mainSid), mainArgs.join(' '));
    const dormant = (await B.state()).agents as any[];
    check('the three agents are listed', dormant.length === 3, JSON.stringify(dormant.map((x) => x.slug)));
    check('they are dormant, with no process', dormant.every((x) => x.state === 'dormant' && x.status !== 'running'), JSON.stringify(dormant));
    check('no agent process was started', ['one-job', 'two-job', 'three-job'].every((n) => b.lastLaunchArgs(n) === undefined));

    const wake = await B.ui('/api/agents/one-job/wake', 'POST', {});
    check('waking one by hand is accepted', wake.status === 200, JSON.stringify(wake));
    check('it runs with its own session', await until(async () => (await B.agent('one-job'))?.status === 'running'));
    const oneArgs = b.lastLaunchArgs('one-job') ?? [];
    check('it was started with --resume of its session', oneArgs.includes('--resume') && oneArgs.includes(sids.get('one-job')!), oneArgs.join(' '));

    b.sendMessage('two-job', 'The review is done.');
    check('work arriving for a dormant agent wakes it', await until(async () => (await B.agent('two-job'))?.status === 'running'));
    check('the third one stays dormant', (await B.agent('three-job'))?.state === 'dormant');
    await b.close();
  }

  // 2. A notification with no browser open; held back while the user is looking at the queue.
  {
    const configDir = tmp('e2e6-cfg-');
    writeConfig(configDir, { notifications: { groupSeconds: 1 } });
    const toasts: Toast[] = [];
    const s = await boot({ projectRoot: tmp('e2e6-project-'), configDir, notifier: { available: async () => true, notify: async (n) => { toasts.push(n); } } });
    const S = api(s);
    const out = await S.asMod('shop-api', '/v1/tools/spawn_agent', 'POST', { name: 'ask-job', profile: 'developer', goal: 'Ask something' });
    check('agent for the notification scenario started', out.json?.status === 'started');
    await until(async () => (await S.agent('ask-job'))?.status === 'running');
    void S.asMod('ask-job', '/v1/tools/ask_user', 'POST', { question: 'Which color?' }); // waits for an answer: not awaited
    check('a toast is raised with no page open', await until(() => toasts.length === 1, 10000), JSON.stringify(toasts));
    check('the toast says who asks and what', toasts[0]?.message === 'ask-job: Which color?', toasts[0]?.message);
    check('clicking it opens the queue item', /\/\?token=.+&project=shop-api#queue=/.test(toasts[0]?.open ?? ''), toasts[0]?.open);

    const seen = await S.ui('/api/presence', 'POST', { focused: true, visible: true, drawerOpen: true, active: 'shop-api' });
    check('the UI reports what the user is looking at', seen.status === 204, String(seen.status));
    void S.asMod('ask-job', '/v1/tools/ask_user', 'POST', { question: 'And the size?' });
    await sleep(3500);
    check('nothing is raised while the user is looking at the queue', toasts.length === 1, JSON.stringify(toasts.map((t) => t.message)));
    check('the state still counts both items (badge and title)', (await S.state()).queue.length === 2);
    await s.close();
  }

  // 3. A project from a template in well under a minute, next to the first one.
  {
    const configDir = tmp('e2e6-cfg-');
    writeConfig(configDir);
    const s = await boot({ projectRoot: tmp('e2e6-project-'), configDir });
    const S = api(s);
    const project = tmp('e2e6-java-');
    writeFileSync(join(project, 'pom.xml'), '<project></project>\n');
    const templates = (await S.ui('/api/templates')).json as any[];
    check('the shipped templates are listed', ['backend-java', 'frontend-web', 'generic'].every((id) => templates.some((t) => t.id === id && t.valid)), JSON.stringify(templates.map((t) => t.id)));
    const t0 = Date.now();
    const detected = (await S.ui(`/api/projects/detect?root=${encodeURIComponent(project)}`)).json;
    check('the project is read and the commands are proposed', detected?.source === 'pom.xml' && typeof detected?.test === 'string', JSON.stringify(detected));
    const created = await S.ui('/api/projects', 'POST', { root: project, name: 'shop-two', templateId: 'backend-java', create: true, ...(detected?.build ? { build: detected.build } : {}), ...(detected?.test ? { test: detected.test } : {}) });
    const seconds = (Date.now() - t0) / 1000;
    check('the project is created', created.status === 201, JSON.stringify(created));
    check(`...in well under a minute (${seconds.toFixed(1)} s)`, seconds < 60);
    check('both projects are open', ((await S.state()).projects ?? []).map((p: any) => p.name).join(',') === 'shop-api,shop-two', JSON.stringify((await S.state()).projects));
    check('its main is running', await until(async () => (await S.state('shop-two')).main.status === 'running'));
    const projectJson = JSON.parse(readFileSync(join(project, '.andromedaconsole', 'project.json'), 'utf8'));
    check('the template put its commands and rules in the project', projectJson.testCommand === detected?.test && existsSync(join(project, '.andromedaconsole', 'rules.md')), JSON.stringify(projectJson));

    const made = await S.ui('/api/agents?project=shop-two', 'POST', { slug: 'two-job', profile: 'developer' });
    check('an agent can be started in the new project', made.status === 201, JSON.stringify(made));
    check('the projects do not share agents', (await S.agent('two-job', 'shop-two')) !== undefined && (await S.agent('two-job')) === undefined);
    const dup = await S.ui('/api/projects', 'POST', { root: project });
    check('the same folder cannot be opened twice', dup.status === 409 && dup.json?.code === 'project.duplicate', JSON.stringify(dup));

    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: 'en-US' });
      await page.goto(`${s.url}/?token=${s.token}`);
      check('the page shows a tab for each project and the new-project button', await until(async () => (await page.locator('#tabs button').count()) >= 3));
    } finally { await browser.close(); }
    await s.close();
  }

  // 4. No project open: the page asks for a project; creating one starts the console as usual.
  {
    const configDir = tmp('e2e6-cfg-');
    writeConfig(configDir);
    const s = await boot({ configDir });
    const S = api(s);
    check('with nothing remembered the host lists no project', ((await S.ui('/api/host')).json?.projects ?? []).length === 0);
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: 'en-US' });
      await page.goto(`${s.url}/?token=${s.token}`);
      check('the page asks for a project', await until(async () => (await page.locator('#welcome h1').count()) > 0 && (await page.locator('#overlay input[name="folder"]').count()) > 0));
      check('the project chrome is hidden', await page.locator('#topbar').isHidden() && await page.locator('#statusbar').isHidden());
      check('the dialog has a Browse button', (await page.locator('#overlay button.browse-folder').count()) === 1);
      const project = tmp('e2e6-new-');
      await page.fill('#overlay input[name="folder"]', project);
      await page.click('#overlay button[type="submit"]');
      check('after creating the project the page starts as usual (tab and new-project button)', await until(async () => (await page.locator('#tabs button').count()) >= 2));
      check('the project is open on the server', ((await S.ui('/api/host')).json?.projects ?? []).length === 1);
      check('the welcome screen is gone', (await page.locator('#welcome').count()) === 0);
    } finally { await browser.close(); }
    await s.close();
  }
} finally {
  for (const s of servers) { try { await s.close(); } catch { /* already closed */ } }
  for (const d of temps) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
