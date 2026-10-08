// `npm run shot -- <options>`: a screenshot of the real UI in Edge, from a throw-away console (fake agent, a temporary config and project).
//   --tab <name>      open the Options dialog on that tab (models, profiles, budget, guard, notifications, language, prerequisites, plugins, projects, git)
//   --lang <code>     interface language (default en)
//   --folder <kind>   the project folder: plain (not a repository, default), repo (a repository with one commit), mixed (not a repository, holds one)
//   --hover <css>     hover this element before the shot (a tooltip, for example)
//   --click <css>     click this element first (repeatable)
//   --out <file>      where to write the PNG (default: shot.png in the temp folder; the path is printed)
// It writes a config file first (without one the first-start wizard covers the page), waits for the splash to go, and always ends the
// process itself (closing a server with a PTY child can hang on Windows).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

process.env.CONSOLE_TEST = '1';

const args = process.argv.slice(2);
const one = (name: string, fallback?: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const many = (name: string): string[] => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []));
const tab = one('tab');
const lang = one('lang', 'en')!;
const kind = one('folder', 'plain')!;
const out = resolve(one('out') ?? join(tmpdir(), 'shot.png'));
if (!['plain', 'repo', 'mixed'].includes(kind)) { console.error('--folder is plain, repo or mixed'); process.exit(1); }

const { startServer } = await import('../src/server/index');
const root = resolve(import.meta.dirname, '..');
const fixture = join(root, 'test', 'fixtures', 'fake-agent.cjs');
const git = (cwd: string, ...a: string[]): void => { execFileSync('git', ['-c', 'user.name=Shot', '-c', 'user.email=shot@example.com', ...a], { cwd, stdio: 'ignore' }); };

const configDir = mkdtempSync(join(tmpdir(), 'shot-cfg-'));
const project = mkdtempSync(join(tmpdir(), 'shot-proj-'));
writeFileSync(join(configDir, 'config.json'), JSON.stringify({ schema: 1, language: lang })); // a saved config: no first-start wizard
if (kind === 'repo') { git(project, 'init', '-q', '-b', 'main'); writeFileSync(join(project, 'README.md'), 'hello\n'); git(project, 'add', '-A'); git(project, 'commit', '-q', '-m', 'init'); }
if (kind === 'mixed') { const sub = join(project, 'sub-repo'); mkdirSync(sub); git(sub, 'init', '-q', '-b', 'main'); }

const server = await startServer({ port: 0, projectRoot: project, projectName: 'shot-demo', configDir, claudeCommand: [process.execPath, fixture], modDir: null, projectsDir: tmpdir() } as Parameters<typeof startServer>[0]);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(`${server.url}/?token=${server.token}`);
  await page.waitForSelector('#splash', { state: 'hidden', timeout: 40_000 });
  if (tab) {
    await page.click('#settings-btn');
    await page.click(`.options-tab[data-tab="${tab}"]`);
    await page.waitForTimeout(600);
  }
  for (const sel of many('click')) await page.click(sel);
  const hover = one('hover');
  if (hover) { await page.hover(hover); await page.waitForTimeout(300); }
  await page.screenshot({ path: out });
  console.log(out);
} catch (e) {
  failed = true;
  console.error(`shot failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
} finally {
  setTimeout(() => process.exit(failed ? 1 : 0), 3000).unref();
  await browser.close();
  process.exit(failed ? 1 : 0);
}
