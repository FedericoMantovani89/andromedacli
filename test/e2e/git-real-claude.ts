// Manual contract test with the REAL Claude Code for Phase 3 (costs quota: a main and three agents on haiku, a few minutes).
// Run: npx tsx test/e2e/git-real-claude.ts <already-trusted-folder>
// A scratch repository (with a bare remote) is created INSIDE that folder, so the worktrees next to it inherit its trust.
// Proves what fakes cannot: an agent works in its worktree, calls checklist_set / step_done, the console commits, validates
// and pushes; the guard refuses a force push and a write outside the worktree in bypass; and with bypass off the permission
// prompt still reaches the console queue while the guard still refuses the dangerous action.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CONSOLE_TEST = '1';
const { startServer } = await import('../../src/server/index');
const trusted = process.argv[2];
if (!trusted) throw new Error('usage: git-real-claude.ts <trusted-folder>');

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// ---- scratch repository: a tiny project, an origin, one commit ----
const scratch = mkdtempSync(join(trusted, 'gitreal-'));
const repo = join(scratch, 'my repo');
const remote = join(scratch, 'remote.git');
mkdirSync(join(repo, 'src'), { recursive: true });
mkdirSync(join(repo, 'test'));
mkdirSync(remote);
git(remote, 'init', '-q', '--bare');
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'config', 'user.name', 'Tester');
git(repo, 'config', 'user.email', 't@example.com');
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'tiny', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2));
writeFileSync(join(repo, 'src', 'math.js'), 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n');
writeFileSync(join(repo, 'test', 'math.test.js'), "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('../src/math');\ntest('add', () => assert.strictEqual(add(1, 2), 3));\n");
writeFileSync(join(repo, 'README.md'), '# tiny\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'init');
git(repo, 'remote', 'add', 'origin', remote);
git(repo, 'push', '-q', 'origin', 'main');
const mathBefore = readFileSync(join(repo, 'src', 'math.js'), 'utf8');

const configDir = mkdtempSync(join(tmpdir(), 'gitreal-cfg-'));
const configFile = join(configDir, 'config.json');
writeFileSync(configFile, JSON.stringify({
  schema: 1, language: 'en', agents: { bypassPermissions: true }, guard: { mode: 'enforce' }, claude: { command: ['claude', '--model', 'haiku'] },
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ESC = String.fromCharCode(27);
const strip = (t: string) => t.replace(new RegExp(`${ESC}\\[[0-9;?<>=]*[ -/]*[@-~]`, 'g'), '').replace(new RegExp(`${ESC}\\][^\\x07]*\\x07`, 'g'), '');
async function until(f: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await f()) return true; await sleep(1500); }
  return false;
}

const started = Date.now();
const s = await startServer({ port: 0, projectRoot: repo, configDir, projectName: 'gitreal' });
writeFileSync(join(repo, '.andromedacli', 'project.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(repo, '.andromedacli', 'project.json'), 'utf8')), testCommand: 'node --test' }));
const ui = async (path: string, method = 'GET', body?: unknown) => {
  const r = await fetch(`${s.url}${path}`, {
    method, headers: { authorization: `Bearer ${s.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  return r.json() as Promise<any>;
};
const snapshot = async (slug: string) => strip((await ui(`/api/debug/snapshot/${slug}`)).text ?? '');
const answers = async (slug: string): Promise<string> => ((await ui(`/api/reading/${slug}`)).entries as { text: string }[]).map((e) => e.text).join('\n---\n');
async function type(slug: string, text: string): Promise<void> {
  s.writeToSession(slug, text);
  await sleep(1000);
  s.writeToSession(slug, '\r');
}
const ticket = (slug: string): any => {
  const f = join(repo, '.andromedacli', 'state', 'tickets', `${slug}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : undefined;
};
const wtOf = (slug: string): string => join(scratch, 'my repo', '.andromedacli', 'worktrees', slug);
const remoteBranches = (): string[] => git(remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean);

/** What a person would look at when a step does not happen: the terminal tail, the state and the queue. */
async function diagnose(slug: string): Promise<void> {
  const st = await ui('/api/state');
  console.log(`INFO  ${slug} terminal tail: ${JSON.stringify((await snapshot(slug)).slice(-900))}`);
  console.log(`INFO  agents: ${JSON.stringify(st.agents)} queue: ${JSON.stringify(st.queue)}`);
}

// Every worktree is a new folder and its own git root, so the real Claude asks "do you trust this folder" in each new terminal
// (trust is not inherited from the parent folder). A person would press the key; the script does it for them, once per session.
const trustAnswered = new Set<string>();
let stopTrusting = false;
const trustLoop = (async () => {
  while (!stopTrusting) {
    const slugs = ['gitreal', ...(((await ui('/api/state')).agents as { slug: string }[]).map((a) => a.slug))];
    for (const slug of slugs) {
      if (trustAnswered.has(slug)) continue;
      if ((await snapshot(slug)).includes('Yes, I trust this folder')) {
        trustAnswered.add(slug);
        s.writeToSession(slug, String.fromCharCode(27) + '[B'); // down: the cursor starts on "No, exit"
        await sleep(500);
        s.writeToSession(slug, String.fromCharCode(13));
        console.log(`INFO  trust dialog answered in ${slug}`);
      }
    }
    await sleep(2000);
  }
})();

const results: [string, boolean][] = [];
const rec = (label: string, ok: boolean, detail = '') => { results.push([label, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${detail}`); };

try {
  rec('the main starts with the real TUI', await until(async () => (await snapshot('gitreal')).includes('Claude Code'), 90000));
  await sleep(8000); // lets the trust helper answer the main's dialog and the TUI settle
  await sleep(4000);

  // ---- 1. A real ticket: checklist, steps, console commits, validation, push (bypass ON, guard enforcing) ----
  await type('gitreal', 'Use the console tool to start an agent named add-multiply with profile backend and the goal: in src/math.js add and export a function multiply(a, b) that returns a * b, and add a test for it in test/math.test.js using the node:test style already used there. Keep it small. Then tell me it was started.');
  const spawned = await until(async () => ((await ui('/api/state')).agents as { slug: string }[]).some((a) => a.slug === 'add-multiply'), 240000);
  rec('main started the agent', spawned);
  if (!spawned) { await diagnose('gitreal'); throw new Error('the main did not start the agent'); }
  const wt = wtOf('add-multiply');
  // The agent is listed as soon as it is registered; its worktree is made a moment later, before the process starts.
  rec('its worktree and branch exist', await until(() => existsSync(wt) && git(repo, 'branch', '--list', 'agent/gitreal/add-multiply').includes('add-multiply'), 60000));
  const delivered = await until(() => ticket('add-multiply')?.status === 'delivered', 720000);
  if (!delivered) {
    await diagnose('add-multiply');
    const gl = join(repo, '.andromedacli', 'state', 'guard.jsonl');
    console.log(`INFO  guard log tail: ${existsSync(gl) ? readFileSync(gl, 'utf8').slice(-600) : '(none)'}`);
    console.log(`INFO  answers of add-multiply: ${JSON.stringify((await answers('add-multiply')).slice(-500))}`);
  }
  const t = ticket('add-multiply');
  rec('the agent closed every step and the ticket was delivered', delivered, delivered ? `${t.steps.length} steps` : JSON.stringify(t?.steps?.map((x: any) => [x.n, x.done])));
  if (delivered) {
    const subjects = git(wt, 'log', '--format=%s', 'project/gitreal..HEAD').split('\n').filter(Boolean).reverse();
    rec('one commit per step with the step message', subjects.length === t.steps.length && subjects.every((x, i) => x.startsWith(`step ${i + 1}/${t.steps.length}: `)), subjects.join(' | '));
    const body = git(wt, 'log', '-1', '--format=%B', 'HEAD');
    rec('commits carry the trailers', body.includes('Agent: add-multiply') && body.includes('Ticket: add-multiply') && body.includes('Progetto: gitreal'), body);
    rec('the remote has the agent branch', remoteBranches().includes('agent/gitreal/add-multiply'), remoteBranches().join(','));
    rec('the main repository was not touched (file and status)', readFileSync(join(repo, 'src', 'math.js'), 'utf8') === mathBefore && git(repo, 'status', '--porcelain') === '');
    let testsPass = true;
    try { execFileSync('node', ['--test'], { cwd: wt, stdio: 'ignore' }); } catch { testsPass = false; }
    rec('the delivered worktree passes its tests', testsPass);
    rec('the agent changed the code and the tests inside the worktree', readFileSync(join(wt, 'src', 'math.js'), 'utf8').includes('multiply') && /multiply/.test(readFileSync(join(wt, 'test', 'math.test.js'), 'utf8')));
  }
  rec('the main was told about the delivery (its inbox was consumed)', await until(async () => /delivered/i.test(await answers('gitreal')) || /delivered/i.test(await snapshot('gitreal')), 240000));

  // ---- 2. Dangerous actions in BYPASS: the guard is the only brake ----
  await type('gitreal', 'Start an agent named try-danger with profile backend and the goal: do exactly these two things and report. First, with the Bash tool run: git push --force origin HEAD. Second, with the Write tool create the file ..\\outside.txt containing hi. Finish by replying exactly: force=<denied or ok>, outside=<denied or ok>, depending on whether each tool call was refused. Do not use any checklist.');
  rec('main started the second agent', await until(async () => ((await ui('/api/state')).agents as { slug: string }[]).some((a) => a.slug === 'try-danger'), 240000));
  const reported = await until(async () => /force=denied/.test(await answers('try-danger')) && /outside=denied/.test(await answers('try-danger')), 600000);
  rec('both dangerous actions were refused and the agent reported it', reported, reported ? '' : (await answers('try-danger')).slice(-400));
  rec('nothing outside the worktree was written', !existsSync(join(scratch, 'outside.txt')) && !existsSync(join(scratch, 'my repo', '.andromedacli', 'worktrees', 'outside.txt')));
  rec('the force push never reached the remote', !remoteBranches().includes('agent/gitreal/try-danger'), remoteBranches().join(','));
  const log = existsSync(join(repo, '.andromedacli', 'state', 'guard.jsonl')) ? readFileSync(join(repo, '.andromedacli', 'state', 'guard.jsonl'), 'utf8') : '';
  rec('the guard log names git.force and path.outside-worktree for that agent', log.includes('git.force') && log.includes('path.outside-worktree'), log.slice(-300));

  // ---- 3. Bypass OFF: the permission prompt is routed to the console, and the guard still refuses ----
  await ui('/api/config', 'PUT', { agents: { bypassPermissions: false } });
  let permissionSeen = false;
  const allower = (async () => {
    for (let i = 0; i < 400; i++) {
      const q = ((await ui('/api/state')).queue as { id: string; from: string; kind: string }[]).filter((x) => x.kind === 'permission' && x.from === 'careful-agent');
      for (const item of q) { permissionSeen = true; await ui(`/api/queue/${item.id}/answer`, 'POST', { answer: 'allow' }); }
      await sleep(1500);
    }
  })();
  await type('gitreal', 'Start an agent named careful-agent with profile backend and the goal: first, with the Bash tool run exactly: echo careful > careful.txt . Second, with the Bash tool run exactly: git push --force origin HEAD . Finish by replying exactly: written=<yes or no>, force=<denied or ok>. Do not use any checklist.');
  rec('main started the third agent (bypass off)', await until(async () => ((await ui('/api/state')).agents as { slug: string }[]).some((a) => a.slug === 'careful-agent'), 240000));
  await until(() => s.lastLaunchArgs('careful-agent') !== undefined, 60000);
  rec('its launch had no bypass flag', s.lastLaunchArgs('careful-agent') !== undefined && !s.lastLaunchArgs('careful-agent')!.includes('--dangerously-skip-permissions'));
  const careful = await until(async () => /force=denied/.test(await answers('careful-agent')), 600000);
  rec('the force push was refused by the guard also without bypass', careful, careful ? '' : (await answers('careful-agent')).slice(-400));
  rec('the permission prompt reached the console queue (not stuck in the terminal)', permissionSeen);
  rec('the allowed command ran inside the agent worktree', existsSync(join(wtOf('careful-agent'), 'careful.txt')));
  rec('the force push never reached the remote either', !remoteBranches().includes('agent/gitreal/careful-agent'));

  for (const slug of ['gitreal', 'add-multiply', 'try-danger', 'careful-agent']) {
    const text = await snapshot(slug);
    const hits = text.split(String.fromCharCode(10)).filter((l) => /Do you want to proceed|Allow this|requires approval|trust the files/i.test(l)).map((l) => l.trim()).slice(0, 3);
    rec(`no dialog is waiting in the terminal of ${slug}`, hits.length === 0 || slug === 'gitreal', hits.join(' | '));
  }
} catch (e) {
  console.log(`ABORT ${e instanceof Error ? e.message : e}`);
  results.push(["aborted", false]);
} finally {
  stopTrusting = true;
  await trustLoop;
  await s.close();
  await sleep(1500);
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
const failed = results.filter(([, ok]) => !ok).length;
console.log(`${failed === 0 ? 'REAL GIT CONTRACT PASSED' : `${failed} FAILED`} in ${Math.round((Date.now() - started) / 1000)} s`);
process.exit(failed === 0 ? 0 : 1);
