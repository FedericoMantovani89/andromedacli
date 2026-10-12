// Phase 1 acceptance (SPEC 24): drives the real UI in Edge against a real server with a fake agent (no Claude quota).
// Run with: npx tsx test/e2e/phase1.spec.ts   (after `npm run build`)
import { chromium, type Browser, type Page } from 'playwright-core';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

process.env.CONSOLE_TEST = '1';
const { startServer } = await import('../../src/server/index');

const root = resolve(import.meta.dirname, '..', '..');
const fixture = join(root, 'test', 'fixtures', 'fake-agent.cjs').replace(/\\/g, '/');
let failures = 0;
const pass = (label: string) => console.log(`PASS  ${label}`);
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) pass(label);
  else { failures++; console.log(`FAIL  ${label} ${detail}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => Promise<boolean> | boolean, ms = 10000): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await f()) return true; await sleep(50); }
  return false;
}

async function boot(opts: { configured: boolean }) {
  const configDir = mkdtempSync(join(tmpdir(), 'e2e-cfg-'));
  if (opts.configured) writeFileSync(join(configDir, 'config.json'), JSON.stringify({ schema: 1, language: 'en', git: { worktrees: false } }));
  const projectRoot = mkdtempSync(join(tmpdir(), 'e2e-project-'));
  const s = await startServer({ port: 0, projectRoot, configDir, projectName: 'shop-api', claudeCommand: [process.execPath, fixture], worktrees: false });
  s.setLimits({ global: 64, perProject: 64 }); // fake agents never report events, so they stay "starting" and would hold slots
  const get = async (path: string) => (await fetch(`${s.url}${path}`, { headers: { authorization: `Bearer ${s.token}` } })).json() as Promise<any>;
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${s.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  return { s, get, post, snapshot: async (id: string): Promise<string> => (await get(`/api/debug/snapshot/${id}`)).text as string };
}

const browser: Browser = await chromium.launch({ channel: 'msedge', headless: true });
const open = async (url: string, size = { width: 1400, height: 900 }): Promise<Page> => {
  const page = await browser.newPage({ viewport: size, locale: 'en-US' }); // fixed locale: "auto" language follows the browser
  await page.goto(url);
  return page;
};
const panel = (slug: string) => `.panel[data-slug="${slug}"]`;

try {
  // 1. Three agents are created while the user types into main: no focus theft.
  {
    const { s, post, get, snapshot } = await boot({ configured: true });
    const page = await open(`${s.url}/?token=${s.token}`);
    check('main panel renders', await until(async () => (await page.locator(`${panel('shop-api')} .xterm`).count()) > 0));
    await until(async () => (await snapshot('shop-api')).includes('READY'));
    const typed = 'abcdefghijklmnopqrst';
    const typing = page.keyboard.type(typed, { delay: 100 }); // starts without any click: main owns the keyboard at open
    await sleep(150);
    for (const slug of ['one-job', 'two-job', 'three-job']) { await post('/api/agents', { slug, profile: 'developer' }); await sleep(150); }
    await typing;
    await page.keyboard.press('Enter');
    check('typed text reached main intact', await until(async () => (await snapshot('shop-api')).includes(`ECHO:${typed}`)), await snapshot('shop-api'));
    for (const slug of ['one-job', 'two-job', 'three-job']) {
      check(`no typed text in ${slug}`, !(await snapshot(slug)).includes('ECHO:'));
    }
    const owner = await page.evaluate(() => (document.activeElement?.closest('.panel') as HTMLElement | null)?.dataset.slug ?? null);
    check('keyboard still in main after 3 agents appeared', owner === 'shop-api', String(owner));
    const state = await get('/api/state');
    check('3 agents running', state.agents.length === 3 && state.agents.every((a: any) => a.status === 'running'));
    check('active badge only on main', (await page.locator('.panel.active').count()) === 1 && (await page.locator(`${panel('shop-api')}.active`).count()) === 1);

    // Alt+2 moves the focus to the first agent (explicit user action)
    await page.keyboard.press('Alt+2');
    check('Alt+2 activates the first agent', (await page.locator(`${panel('one-job')}.active`).count()) === 1);

    // 3. Resize
    const sizeOf = async () => get('/api/debug/size/shop-api');
    await page.setViewportSize({ width: 1000, height: 700 });
    await sleep(800);
    const a = await sizeOf();
    await page.setViewportSize({ width: 1400, height: 900 });
    await sleep(800);
    const b = await sizeOf();
    check('terminal resizes with the window', b.cols > a.cols && b.rows > a.rows, JSON.stringify({ a, b }));

    // 2. Close and reopen the tab: processes and scrollback survive
    await page.click(`${panel('one-job')} .xterm`);
    await page.keyboard.type('persist-me');
    await page.keyboard.press('Enter');
    check('agent echoed before closing the tab', await until(async () => (await snapshot('one-job')).includes('ECHO:persist-me')));
    await page.close();
    const again = await open(`${s.url}/?token=${s.token}`);
    check('reopened tab restores the scrollback', await until(async () => ((await again.locator(`${panel('one-job')} .xterm-rows`).innerText().catch(() => '')) as string).includes('ECHO:persist-me')));
    const after = await get('/api/state');
    check('processes survived the closed tab', after.main.status === 'running' && after.agents.every((x: any) => x.status === 'running'));

    // 4. Slug rules through the UI
    await again.click('#new-agent-btn');
    await again.fill('input[name="slug"]', 'agent-1');
    await again.click('.new-agent-form button[type="submit"]');
    check('generic slug rejected with the translated message',
      await until(async () => (await again.locator('.form-error').innerText()).includes('"agent-1" is too generic')));
    check('rejected slug did not create a panel', (await again.locator(panel('agent-1')).count()) === 0);
    const dup1 = await post('/api/agents', { slug: 'fix-login', profile: 'developer' });
    const dup2 = await post('/api/agents', { slug: 'fix-login', profile: 'developer' });
    check('duplicate slug rejected', dup1.status === 201 && dup2.status === 422 && dup2.body.code === 'slug.duplicate');

    // 5. i18n switch at runtime, no navigation
    let navigations = 0;
    again.on('framenavigated', () => { navigations++; });
    check('English badge before switching', (await again.locator('.badge').first().innerText()) === 'ACTIVE INPUT');
    await again.click('#settings-btn');
    await again.click('.options-tab[data-tab="language"]');
    await again.selectOption('.dialog select', 'it');
    check('badge switches to Italian without reloading',
      await until(async () => (await again.locator('.badge').first().innerText()) === 'INPUT ATTIVO') && navigations === 0);
    await again.selectOption('.dialog select', 'en');
    check('and back to English', await until(async () => (await again.locator('.badge').first().innerText()) === 'ACTIVE INPUT'));
    await again.close();

    // 6. A page from another origin cannot open the WebSocket even with a valid token
    const other = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>x</title>'); });
    await new Promise<void>((ok) => other.listen(0, '127.0.0.1', () => ok()));
    const evil = await browser.newPage({ locale: 'en-US' });
    await evil.goto(`http://127.0.0.1:${(other.address() as any).port}/`);
    const result = await evil.evaluate((url) => new Promise<string>((resolve) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve('open');
      ws.onerror = () => resolve('refused');
    }), `ws://127.0.0.1:${s.port}/ws/ui?token=${s.token}`);
    check('cross-origin WebSocket is refused', result === 'refused', result);
    await evil.close();
    other.close();
    await s.close();
  }

  // 8. With more than 4 agents (bars), a state update must not move the node the user is typing in (reviewer finding)
  {
    const { s, post } = await boot({ configured: true });
    for (const slug of ['one-job', 'two-job', 'three-job', 'four-job', 'five-job', 'six-job']) await post('/api/agents', { slug, profile: 'developer' });
    const page = await open(`${s.url}/?token=${s.token}`);
    check('agents beyond 4 collapse to bars', await until(async () => (await page.locator('.bar').count()) === 2));
    await page.click('#new-agent-btn');
    const slugInput = page.locator('input[name="slug"]');
    await slugInput.pressSequentially('hello', { delay: 60 });
    await post('/api/agents', { slug: 'seven-job', profile: 'developer' }); // state broadcast while typing
    await until(async () => (await page.locator('.bar').count()) === 3);
    await slugInput.pressSequentially('world', { delay: 60 });
    check('typing in the new-agent form survives a state update with bars present', (await slugInput.inputValue()) === 'helloworld', await slugInput.inputValue());
    check('the form field still owns the keyboard', await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.name === 'slug'));
    await page.close();
    await s.close();
  }

  // 9. Minors: keystrokes never go to a hidden terminal behind the wizard; a wrong token says so; status bar numbers are honest
  {
    const { s, post, snapshot } = await boot({ configured: false });
    const page = await open(`${s.url}/?token=${s.token}`);
    await until(async () => (await snapshot('shop-api')).includes('READY'));
    await until(async () => (await page.locator('.dialog').count()) > 0);
    await page.keyboard.type('zzz');
    await page.keyboard.press('Enter');
    await sleep(500);
    check('keys typed behind the first-start wizard do not reach main', !(await snapshot('shop-api')).includes('ECHO:zzz'));
    for (let i = 0; i < 3 && !(await page.locator('#overlay').isHidden()); i++) await page.click('.dialog .wizard-next');
    await until(async () => await page.locator('#overlay').isHidden());
    await page.keyboard.type('yyy');
    await page.keyboard.press('Enter');
    check('after the wizard closes the keyboard is back in main', await until(async () => (await snapshot('shop-api')).includes('ECHO:yyy')));
    check('queue shows the real count (nothing is waiting)', (await page.locator('#queue-btn').getAttribute('aria-label')) === 'Queue (0)', String(await page.locator('#queue-btn').getAttribute('aria-label')));
    for (const slug of ['one-job', 'two-job']) await post('/api/agents', { slug, profile: 'developer' });
    // "Agents active/max" since Phase 5 (SPEC 16.7): two agents are active, the main session is not counted
    check('status bar counts agents without the main session', await until(async () => /\bAgents 2\/\d+\b/.test(await page.locator('#statusbar').innerText())), await page.locator('#statusbar').innerText());
    await page.close();
    const bad = await open(`${s.url}/?token=wrong`);
    check('a wrong token explains itself instead of a blank page', await until(async () => (await bad.locator('#overlay').innerText().catch(() => '')).includes('Not authorized.')));
    await bad.close();
    await s.close();
  }

  // First-start wizard: Next through every step, never loops
  {
    const { s } = await boot({ configured: false });
    const page = await open(`${s.url}/?token=${s.token}`);
    check('wizard appears on first start', await until(async () => (await page.locator('.dialog .wizard-eyebrow').first().innerText().catch(() => '')).toLowerCase().includes('first start')));
    for (let i = 0; i < 3 && !(await page.locator('#overlay').isHidden()); i++) await page.click('.dialog .wizard-next');
    check('wizard closes after the last step', await until(async () => await page.locator('#overlay').isHidden()));
    await page.reload();
    await sleep(1200);
    check('wizard does not come back after a reload', await page.locator('#overlay').isHidden());
    await page.close();
    await s.close();
  }

  // 5b. The static page carries no visible text of its own
  {
    const html = readFileSync(join(root, 'dist', 'ui', 'index.html'), 'utf8');
    const body = html.slice(html.indexOf('<body>'));
    // The only text is the build version, a placeholder the server fills in (a version number is not translatable text).
    const visible = body.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, '').replace(/%VERSION%/g, '').trim();
    check('index.html body has no literal text', visible === '', JSON.stringify(visible));
  }

  // 5c. The build check fails when a language loses a key, and passes again once restored
  {
    const itFile = join(root, 'src', 'i18n', 'messages_it.properties');
    const original = readFileSync(itFile, 'utf8');
    const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const run = () => { try { execFileSync(process.execPath, [tsx, join(root, 'scripts', 'check-i18n.ts')], { cwd: root, stdio: 'pipe' }); return 0; } catch { return 1; } };
    check('i18n check passes on the shipped bundles', run() === 0);
    try {
      writeFileSync(itFile, original.split('\n').filter((l) => !l.startsWith('common.next=')).join('\n'));
      check('i18n check fails when a key is missing in a language', run() === 1);
    } finally {
      writeFileSync(itFile, original);
    }
    check('i18n check passes again after restoring', run() === 0);
  }

  // 7. English-only code: no accented letters in src/ or scripts/ outside the Italian bundle
  {
    let hits = '';
    try {
      hits = execFileSync('git', ['grep', '--no-index', '-InP', '[àèéìòùÀÈÉÌÒÙ]', '--', 'src', 'scripts', ':!src/i18n/messages_it.properties', ':!*.jpg'], { cwd: root, encoding: 'utf8' });
    } catch { /* git grep exits 1 when nothing matches */ }
    check('no Italian text in code or comments', hits.trim() === '', hits.slice(0, 300));
  }
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
