// Phase 5 acceptance (SPEC 24): Edge against a real server, a real temporary git repository with a bare remote, fake agent
// processes and a "fake mod" that speaks /v1 with each session's own token. Scenarios run in order, in one browser.
// Run with: npx tsx test/e2e/phase5.spec.ts (after `npm run build`).
import { chromium, type Browser, type Page } from 'playwright-core';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { makeRepo, gitSync, type TestRepo } from '../git-helpers';
import type { SleepClock } from '../../src/server/budget/sleep';

process.env.CONSOLE_TEST = '1';
const { startServer } = await import('../../src/server/index');
const { transcriptPath } = await import('../../src/server/budget/transcript');

const root = resolve(import.meta.dirname, '..', '..');
const fixture = join(root, 'test', 'fixtures', 'fake-agent.cjs').replace(/\\/g, '/');
let failures = 0;
type Detail = string | (() => string | Promise<string>);
/** The detail is computed only when the check fails, so a passing run costs no extra browser round-trip. */
async function check(label: string, ok: boolean, detail: Detail = ''): Promise<void> {
  if (ok) { console.log(`PASS  ${label}`); return; }
  failures++;
  let text = '';
  try { text = typeof detail === 'function' ? await detail() : detail; } catch (err) { text = `(detail failed: ${String(err)})`; }
  console.log(`FAIL  ${label} ${text}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => Promise<boolean> | boolean, ms = 15000): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await f()) return true; await sleep(50); }
  return false;
}
const worktreeOf = (t: TestRepo, slug: string): string => join(t.base, 'my repo', '.andromedacli', 'worktrees', slug);
const wipCommits = (wt: string): string[] => gitSync(wt, 'log', '--format=%s').split('\n').filter((l) => l.startsWith('wip:'));
const classesOf = async (loc: ReturnType<Page['locator']>): Promise<string[]> => ((await loc.getAttribute('class')) ?? '').split(/\s+/);

// Everything a scenario creates (pages, servers, temp folders) registers its undo here; it runs after the scenario, pass or fail,
// newest first, and each undo failing never stops the others.
type Undo = () => void | Promise<void>;
let scope: Undo[] = [];
const onCleanup = (u: Undo): void => { scope.push(u); };
async function runCleanup(): Promise<void> {
  const todo = scope.reverse();
  scope = [];
  for (const u of todo) { try { await u(); } catch { /* best effort */ } }
}
/**
 * The sleep timer's clock, moved by hand (the same contract as `fakeSleepClock` in test/helpers.ts, which cannot be imported here
 * because it loads vitest). It starts at the real time so the browser's countdown, computed from the real clock, is meaningful.
 */
function manualClock(start = Date.now()) {
  let t = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: SleepClock = {
    now: () => t,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimeout: (h) => { timers.delete(h as number); },
  };
  const advance = (ms: number): void => {
    const target = t + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, x]) => x.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      t = Math.max(t, due[1].at);
      due[1].fn();
    }
    t = target;
  };
  return { clock, advance, now: () => t };
}
const rmTemp = (dir: string): Undo => () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });

async function boot(o: { config?: Record<string, unknown>; sleepClock?: SleepClock } = {}) {
  const t = makeRepo({ remote: true });
  onCleanup(rmTemp(t.base));
  const configDir = mkdtempSync(join(tmpdir(), 'e2e5-cfg-'));
  onCleanup(rmTemp(configDir));
  const projectsDir = mkdtempSync(join(tmpdir(), 'e2e5-proj-'));
  onCleanup(rmTemp(projectsDir));
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ schema: 1, language: 'en', ...o.config }));
  const s = await startServer({
    port: 0, projectRoot: t.repo, configDir, projectName: 'shop-api', claudeCommand: [process.execPath, fixture], modDir: null, projectsDir,
    ...(o.sleepClock ? { sleepClock: o.sleepClock } : {}),
  });
  onCleanup(async () => { await s.close(); console.log('(server closed)'); });
  // Room for every agent, reviewer and recovery a scenario starts: the active-agent limit is not what these scenarios test.
  s.setLimits({ global: 20, perProject: 20 });
  const call = async (token: string | undefined, path: string, method = 'GET', body?: unknown) => {
    const r = await fetch(`${s.url}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json: any = null;
    try { json = await r.json(); } catch { /* 204 */ }
    return { status: r.status, json };
  };
  const asMod = (slug: string, path: string, method = 'GET', body?: unknown) => call(s.sessionTokenFor(slug), path, method, body);
  const asUi = (path: string, method = 'GET', body?: unknown) => call(s.token, path, method, body);
  const event = (slug: string, type: string, data?: unknown) => asMod(slug, '/v1/events', 'POST', { type, sessionId: `sess-${slug}`, data });
  // The explicit budget is the one under test: the profile's own budget_tokens beats the config default (budget.agentTokens).
  const spawn = (name: string, goal = 'Do the work', budget = 1000) => asMod('shop-api', '/v1/tools/spawn_agent', 'POST', { name, profile: 'backend', goal, budget });
  // Writes one assistant line with `out` output tokens in the transcript the server will read for this agent.
  const addTokens = (slug: string, out: number, n: number): void => {
    const file = transcriptPath(projectsDir, worktreeOf(t, slug), `sess-${slug}`);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: `msg_${n}`, model: 'claude-test', usage: { input_tokens: 0, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [] } })}\n`);
  };
  // One assistant line that calls a tool (with one output token, so the turn has usage): what the loop detector reads.
  let toolN = 0;
  const addToolCall = (slug: string, name: string, input: Record<string, unknown>): void => {
    toolN++;
    const file = transcriptPath(projectsDir, worktreeOf(t, slug), `sess-${slug}`);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: `msg_tool_${toolN}`, model: 'claude-test', usage: { input_tokens: 0, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [{ type: 'tool_use', id: `toolu_${toolN}`, name, input }] } })}\n`);
  };
  const tool = (slug: string, name: string, body: unknown = {}) => asMod(slug, `/v1/tools/${name}`, 'POST', body);
  const inbox = async (slug: string): Promise<string[]> => ((await asMod(slug, '/v1/inbox')).json?.messages ?? []).map((m: any) => m.text as string);
  const guard = async (slug: string, toolName: string, input: unknown): Promise<any> => (await asMod(slug, '/v1/guard', 'POST', { tool: toolName, input })).json;
  const agentOf = async (slug: string): Promise<any> => (await asUi('/api/state')).json.agents.find((a: any) => a.slug === slug);
  const ticketFile = (slug: string): any => { try { return JSON.parse(readFileSync(join(t.repo, '.andromedacli', 'state', 'tickets', `${slug}.json`), 'utf8')); } catch { return undefined; } };
  /** The "budget" scenario's stop, condensed: 850 then 300 of 1000 tokens, no grace; resolves once the ticket is suspended_budget. */
  let msgN = 1000;
  const budgetStop = async (slug: string): Promise<boolean> => {
    writeFileSync(join(worktreeOf(t, slug), `${slug}-work.txt`), 'work in progress\n');
    addTokens(slug, 850, ++msgN);
    await event(slug, 'turn.start');
    await event(slug, 'turn.complete', {});
    await until(async () => (await agentOf(slug))?.budget?.step === 'alert');
    addTokens(slug, 300, ++msgN);
    await event(slug, 'turn.start');
    await event(slug, 'turn.complete', {});
    return until(async () => { const a = await agentOf(slug); return a?.ticket?.status === 'suspended_budget' && a?.status === 'exited'; });
  };
  return { s, t, call, asMod, asUi, event, spawn, addTokens, addToolCall, tool, inbox, guard, agentOf, ticketFile, budgetStop };
}

let browser: Browser | undefined;
const open = async (url: string): Promise<Page> => {
  const page = await browser!.newPage({ viewport: { width: 1500, height: 900 }, locale: 'en-US' });
  onCleanup(() => page.close());
  await page.goto(url);
  return page;
};
const panel = (slug: string) => `.panel[data-slug="${slug}"]`;

const scenarios: { name: string; run: () => Promise<void> }[] = [];
const scenario = (name: string, run: () => Promise<void>): void => { scenarios.push({ name, run }); };

// Block A, criterion 1: the token budget goes ok -> alert (WIP commit) -> limit -> stopped (decision in the queue) -> Close
scenario('budget', async () => {
  // graceMinutes 0 is what the config sets for the stop path; the 1000-token limit comes from the spawn's explicit budget (see boot)
  const { s, t, asUi, event, spawn, addTokens } = await boot({ config: { budget: { agentTokens: 1000, graceMinutes: 0 } } });
  const page = await open(`${s.url}/?token=${s.token}`);
  await until(async () => (await page.locator(`${panel('shop-api')} .xterm`).count()) > 0);
  const started = await spawn('fix-x');
  await check('spawn starts fix-x', started.json.status === 'started', () => JSON.stringify(started.json));
  const wt = worktreeOf(t, 'fix-x');
  await event('fix-x', 'session.start', { cwd: wt });
  const agent = async () => (await asUi('/api/state')).json.agents.find((a: any) => a.slug === 'fix-x');
  const chip = () => page.locator(`${panel('fix-x')} .panel-state`).innerText();
  const budgetChip = page.locator(`${panel('fix-x')} .panel-budget`);
  const ticketChip = page.locator(`${panel('fix-x')} .panel-ticket`);

  // first turn: 850 of 1000 tokens, there is unsaved work to commit
  writeFileSync(join(wt, 'half-done.txt'), 'work in progress\n');
  addTokens('fix-x', 850, 1);
  await event('fix-x', 'turn.start');
  await event('fix-x', 'turn.complete', {});
  await check('the budget chip shows 85%', await until(async () => (await budgetChip.isVisible()) && /85\s*%/.test(await budgetChip.innerText())), () => budgetChip.innerText());
  await check('the budget chip has the alert class', await until(async () => (await classesOf(budgetChip)).includes('alert')), async () => (await classesOf(budgetChip)).join(' '));
  await check('a wip: commit exists in the agent worktree', await until(() => wipCommits(wt).length === 1), () => wipCommits(wt).join(' | '));

  // second turn: 300 more tokens pass the limit; with no grace the agent is stopped on the same turn
  writeFileSync(join(wt, 'more.txt'), 'late work\n');
  addTokens('fix-x', 300, 2);
  await event('fix-x', 'turn.start');
  await event('fix-x', 'turn.complete', {});
  await check('the budget chip reaches stopped', await until(async () => (await classesOf(budgetChip)).includes('stopped')), async () => (await classesOf(budgetChip)).join(' '));
  await check('the state chip reads Suspended', await until(async () => (await chip()) === 'Suspended'), () => chip());
  await check('the ticket chip shows the budget suspension', await until(async () => (await classesOf(ticketChip)).includes('suspended_budget')), async () => (await classesOf(ticketChip)).join(' '));
  // the stop itself, from the server state and from git, not only from chips
  await check('the server state has ticket suspended_budget and the process exited', await until(async () => { const a = await agent(); return a?.ticket?.status === 'suspended_budget' && a?.status === 'exited'; }), async () => JSON.stringify({ ticket: (await agent())?.ticket, status: (await agent())?.status }));
  const wipTouching = (file: string): string[] => gitSync(wt, 'log', '--format=%H%x09%s', '--', file).split('\n').filter((l) => l.split('\t')[1]?.startsWith('wip:'));
  await check('a final wip: commit contains the file created before the second turn', await until(() => wipTouching('more.txt').length === 1), () => `${wipCommits(wt).join(' | ')} / ${wipTouching('more.txt').join(',')}`);
  await check('the queue shows one budget decision', await until(async () => (await page.locator('#drawer .queue-budget').count()) === 1));
  const answers = await page.locator('#drawer .queue-budget button').evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.answer));
  await check('with three buttons: raise, close, recover', JSON.stringify(answers) === JSON.stringify(['raise', 'close', 'recover']), () => JSON.stringify(answers));

  await page.keyboard.press('Alt+Q'); // opens the queue drawer
  await page.click('#drawer .queue-budget button[data-answer="close"]');
  await check('Close puts the ticket in needs_user', await until(async () => (await agent())?.ticket?.status === 'needs_user'), async () => JSON.stringify((await agent())?.ticket));
  await check('the ticket chip follows in the browser', await until(async () => (await classesOf(ticketChip)).includes('needs_user')));
  await check('the queue is empty again', await until(async () => (await page.locator('#drawer .queue-item').count()) === 0));
  await check('the ticket file on disk says needs_user', JSON.parse(readFileSync(join(t.repo, '.andromedacli', 'state', 'tickets', 'fix-x.json'), 'utf8')).status === 'needs_user');
});

const ITEMS = ['Study the code', 'Tests first: ordering', 'Implement a', 'Implement b', 'Validation: run the suite', 'Update documentation'];

// Block B, criterion 2: after a budget stop the main starts a read-only recovery; its report restarts the ticket with a NEW agent on
// the same branch; at most two recoveries per ticket, then the user decides
scenario('recovery', async () => {
  const { s, t, event, spawn, tool, guard, agentOf, ticketFile, budgetStop, inbox } = await boot({ config: { budget: { agentTokens: 1000, graceMinutes: 0 } } });
  const page = await open(`${s.url}/?token=${s.token}`);
  await until(async () => (await page.locator(`${panel('shop-api')} .xterm`).count()) > 0);
  const started = await spawn('fix-x');
  await check('spawn starts fix-x', started.json.status === 'started', () => JSON.stringify(started.json));
  const wt = worktreeOf(t, 'fix-x');
  await event('fix-x', 'session.start', { cwd: wt });
  const set = await tool('fix-x', 'checklist_set', { items: ITEMS });
  await check('fix-x saves a checklist', set.json.status === 'ok', () => JSON.stringify(set.json));
  writeFileSync(join(wt, 'notes.md'), 'what I studied\n');
  const step1 = await tool('fix-x', 'step_done', { n: 1, note: 'studied the code and wrote notes' });
  await check('fix-x closes step 1 (the console commits)', step1.json.status === 'closed', () => JSON.stringify(step1.json));
  await check('the budget stops fix-x (suspended_budget)', await budgetStop('fix-x'), async () => JSON.stringify((await agentOf('fix-x'))?.ticket));
  const branch = 'agent/shop-api/fix-x';
  const commitsBefore = gitSync(t.repo, 'rev-list', branch).split('\n').filter(Boolean);

  // the test plays the main: start_recovery with the main's own session token
  const rec = await tool('shop-api', 'start_recovery', { name: 'fix-x' });
  await check('start_recovery answers ok with recover-fix-x, attempt 1', rec.json.status === 'ok' && rec.json.recovery === 'recover-fix-x' && rec.json.attempt === 1, () => JSON.stringify(rec.json));
  await check('the recovery session exists and runs', await until(async () => (await agentOf('recover-fix-x'))?.status === 'running'), async () => JSON.stringify(await agentOf('recover-fix-x')));
  const recWt = worktreeOf(t, 'recover-fix-x');
  const w = await guard('recover-fix-x', 'Write', { file_path: join(recWt, 'x.md'), content: 'x' });
  await check('the recovery is read-only: a guarded Write is denied', w?.decision === 'deny', () => JSON.stringify(w));
  const fixChip = page.locator(`${panel('fix-x')} .panel-ticket`);
  await check('the ticket chip says Recovering', await until(async () => (await fixChip.innerText().catch(() => '')) === 'Recovering'), () => fixChip.innerText().catch(() => ''));

  const rep = await tool('recover-fix-x', 'recovery_report', { verified_steps: [1], diagnosis: 'loop on tests', remedy: 'split' });
  await check('recovery_report restarts the ticket', rep.json.status === 'ok' && rep.json.outcome === 'restarted', () => JSON.stringify(rep.json));
  await check('a replacement agent fix-x-r2 runs', await until(async () => (await agentOf('fix-x-r2'))?.status === 'running'), async () => JSON.stringify(await agentOf('fix-x-r2')));
  const wt2 = worktreeOf(t, 'fix-x-r2');
  await check('the replacement works on the SAME branch', await until(() => { try { return gitSync(wt2, 'rev-parse', '--abbrev-ref', 'HEAD') === branch; } catch { return false; } }), () => { try { return gitSync(wt2, 'rev-parse', '--abbrev-ref', 'HEAD'); } catch (e) { return String(e); } });
  const kept = ticketFile('fix-x-r2');
  await check('the checklist is kept (all items, step 1 closed)', kept?.steps?.length === ITEMS.length && kept.steps[0].done === true && kept.status === 'in_progress', () => JSON.stringify(kept));
  const commitsAfter = new Set(gitSync(wt2, 'rev-list', 'HEAD').split('\n').filter(Boolean));
  await check('the commits are kept on the branch', commitsBefore.every((c) => commitsAfter.has(c)), () => `${commitsBefore.length} before, missing ${commitsBefore.filter((c) => !commitsAfter.has(c)).join(',')}`);
  await check('the recovery session is gone after ~3 s', await until(async () => { const a = await agentOf('recover-fix-x'); return (!a || a.status === 'exited') && !existsSync(recWt); }, 15000), async () => JSON.stringify(await agentOf('recover-fix-x')));
  const fresh = await agentOf('fix-x-r2');
  await check('the replacement budget starts fresh: step ok, no usage yet (n/a)', kept?.budget?.step === 'ok' && kept?.budget?.limit === 1000 && fresh?.budget === undefined, () => JSON.stringify({ file: kept?.budget, state: fresh?.budget }));
  await check('the replacement got the handover with the diagnosis', (await inbox('fix-x-r2')).some((m) => m.includes('loop on tests') && m.includes('split')));

  // two recoveries per ticket at most: a second one is accepted, a third start is refused and the user decides
  await event('fix-x-r2', 'session.start', { cwd: wt2 });
  await check('fix-x-r2 is stopped by its own (fresh) budget', await budgetStop('fix-x-r2'), async () => JSON.stringify((await agentOf('fix-x-r2'))?.ticket));
  const rec2 = await tool('shop-api', 'start_recovery', { name: 'fix-x-r2' });
  await check('the second recovery starts (attempt 2)', rec2.json.status === 'ok' && rec2.json.attempt === 2, () => JSON.stringify(rec2.json));
  await until(async () => (await agentOf(rec2.json.recovery))?.status === 'running');
  const rep2 = await tool(rec2.json.recovery, 'recovery_report', { verified_steps: [1], diagnosis: 'still too big', remedy: 'split' });
  await check('its report restarts the ticket again', rep2.json.status === 'ok' && rep2.json.outcome === 'restarted', () => JSON.stringify(rep2.json));
  await check('a replacement fix-x-r3 runs', await until(async () => (await agentOf('fix-x-r3'))?.status === 'running'), async () => JSON.stringify(await agentOf('fix-x-r3')));
  await event('fix-x-r3', 'session.start', { cwd: worktreeOf(t, 'fix-x-r3') });
  await check('fix-x-r3 is stopped by its budget', await budgetStop('fix-x-r3'), async () => JSON.stringify((await agentOf('fix-x-r3'))?.ticket));
  const rec3 = await tool('shop-api', 'start_recovery', { name: 'fix-x-r3' });
  await check('a third start_recovery is refused too_many', rec3.json.status === 'refused' && rec3.json.code === 'too_many', () => JSON.stringify(rec3.json));
  await check('and the ticket needs the user', ticketFile('fix-x-r3')?.status === 'needs_user', () => JSON.stringify(ticketFile('fix-x-r3')));
});

// Block B, criterion 2 (the spend): the remedy raise_budget never acts alone; the user approves in the queue, then a new agent starts
scenario('recovery-raise', async () => {
  const { s, t, event, spawn, tool, agentOf, ticketFile, budgetStop } = await boot({ config: { budget: { agentTokens: 1000, graceMinutes: 0 } } });
  const page = await open(`${s.url}/?token=${s.token}`);
  await until(async () => (await page.locator(`${panel('shop-api')} .xterm`).count()) > 0);
  await spawn('fix-y');
  await event('fix-y', 'session.start', { cwd: worktreeOf(t, 'fix-y') });
  await check('the budget stops fix-y', await budgetStop('fix-y'), async () => JSON.stringify((await agentOf('fix-y'))?.ticket));
  const rec = await tool('shop-api', 'start_recovery', { name: 'fix-y' });
  await check('start_recovery answers ok', rec.json.status === 'ok', () => JSON.stringify(rec.json));
  await until(async () => (await agentOf('recover-fix-y'))?.status === 'running');
  const rep = await tool('recover-fix-y', 'recovery_report', { verified_steps: [], diagnosis: 'the work is right but bigger than the budget', remedy: 'raise_budget' });
  await check('raise_budget asks the user instead of acting', rep.json.status === 'ok' && rep.json.outcome === 'asked_user', () => JSON.stringify(rep.json));
  await page.keyboard.press('Alt+Q');
  const decision = page.locator('#drawer .queue-decision');
  await check('the queue shows the raise decision', await until(async () => (await decision.count()) === 1));
  const answers = await decision.locator('button').evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.answer));
  await check('with Approve and Decline', JSON.stringify(answers) === JSON.stringify(['approve', 'decline']), () => JSON.stringify(answers));
  await sleep(1500);
  await check('nothing is spent before Approve: no new agent, ticket still recovering', (await agentOf('fix-y-r2')) === undefined && s.lastLaunchArgs('fix-y-r2') === undefined && ticketFile('fix-y')?.status === 'recovering', async () => JSON.stringify({ a: await agentOf('fix-y-r2'), t: ticketFile('fix-y')?.status }));
  await decision.locator('button[data-answer="approve"]').click();
  await check('Approve starts the replacement fix-y-r2', await until(async () => (await agentOf('fix-y-r2'))?.status === 'running'), async () => JSON.stringify(await agentOf('fix-y-r2')));
  const raised = ticketFile('fix-y-r2')?.budget;
  await check('with the raised budget (1.5 x the 1150 used) at step ok', raised?.limit === 1725 && raised?.step === 'ok', () => JSON.stringify(raised));
});

// Block C, criterion 3: a simulated loop is corrected, then limited (the guard refuses the repeated call), then stopped
scenario('loop', async () => {
  const { s, t, event, spawn, addToolCall, guard, inbox, agentOf, tool } = await boot();
  const page = await open(`${s.url}/?token=${s.token}`);
  await until(async () => (await page.locator(`${panel('shop-api')} .xterm`).count()) > 0);
  // the loop detector reads the tool calls with the budget's transcript read: the agent needs a budget
  const started = await spawn('loop-y', 'Make the tests pass', 1_000_000);
  await check('spawn starts loop-y', started.json.status === 'started', () => JSON.stringify(started.json));
  await event('loop-y', 'session.start', { cwd: worktreeOf(t, 'loop-y') });
  const loopChip = page.locator(`${panel('loop-y')} .panel-loop`);
  const turn = async (calls: string[]): Promise<void> => {
    for (const command of calls) addToolCall('loop-y', 'Bash', { command });
    await event('loop-y', 'turn.start');
    await event('loop-y', 'turn.complete', {});
  };
  const five = Array<string>(5).fill('npm test');

  await turn(five);
  await check('the agent is told to change approach (correction in its inbox)', await until(async () => (await inbox('loop-y')).some((m) => m.startsWith('Loop warning:'))), async () => (await inbox('loop-y')).join(' | ').slice(0, 300));
  await check('the loop chip shows level 1', await until(async () => (await loopChip.innerText().catch(() => '')) === 'Loop: corrected'), () => loopChip.innerText().catch(() => ''));

  await turn(['ls', ...five]);
  await check('the loop chip shows level 2', await until(async () => (await loopChip.innerText().catch(() => '')) === 'Loop: limited'), () => loopChip.innerText().catch(() => ''));
  const denied = await guard('loop-y', 'Bash', { command: 'npm test' });
  await check('the guard refuses the repeated call (loop.repeat)', denied?.decision === 'deny' && denied?.rule === 'loop.repeat', () => JSON.stringify(denied));
  const other = await guard('loop-y', 'Bash', { command: 'ls' });
  await check('and allows a different one', other?.decision === 'allow', () => JSON.stringify(other));

  await turn(['ls', ...five]);
  const ticketChip = page.locator(`${panel('loop-y')} .panel-ticket`);
  await check('the ticket chip says Blocked', await until(async () => (await ticketChip.innerText().catch(() => '')) === 'Blocked'), () => ticketChip.innerText().catch(() => ''));
  await check('the session ended', await until(async () => (await agentOf('loop-y'))?.status === 'exited'), async () => JSON.stringify(await agentOf('loop-y')));
  await check('the main is told to call start_recovery', (await inbox('shop-api')).some((m) => m.includes('loop-y') && m.includes('start_recovery')));
  const rec = await tool('shop-api', 'start_recovery', { name: 'loop-y' });
  await check('start_recovery accepts the blocked ticket', rec.json.status === 'ok', () => JSON.stringify(rec.json));
  await check('the recovery goal names the loop as the cause', await until(async () => (await inbox(rec.json.recovery ?? 'recover-loop-y')).some((m) => m.includes('stop cause: loop'))));
});

// Block D, criterion 4: a fake limit; no idle attempt while sleeping; at the reset only the main wakes and decides what to resume
scenario('limit', async () => {
  const fake = manualClock();
  const { s, t, event, spawn, tool, inbox, agentOf, asUi, ticketFile } = await boot({ sleepClock: fake.clock });
  const page = await open(`${s.url}/?token=${s.token}`);
  await until(async () => (await page.locator(`${panel('shop-api')} .xterm`).count()) > 0);
  for (const slug of ['lim-a', 'lim-b']) {
    const r = await spawn(slug, 'Do the work', 400_000);
    await check(`spawn starts ${slug}`, r.json.status === 'started', () => JSON.stringify(r.json));
    await event(slug, 'session.start', { cwd: worktreeOf(t, slug) });
  }
  const quota = (percentUsed: number, resetsAt?: string) => event('shop-api', 'quota', { rateLimits: [{ kind: 'five_hour', percentUsed, ...(resetsAt ? { resetsAt } : {}) }] });
  const resetsAt = new Date(fake.now() + 10 * 60_000).toISOString();
  const bar = page.locator('#statusbar');
  const state = async () => (await asUi('/api/state')).json;

  // 96%: every agent is stopped in order and suspended for the limit; the main keeps running
  await quota(96, resetsAt);
  await check('the status bar shows the quota at 96%', await until(async () => (await bar.innerText()).includes('Quota 96%')), () => bar.innerText());
  // the reset time is known: the sleep starts with the stop (at 95-99% no probe is tried before the reset)
  await check('the sleep starts at the 95% stop', await until(async () => (await state()).sleep?.phase === 'sleeping'), async () => JSON.stringify((await state()).sleep));
  const chipA = page.locator(`${panel('lim-a')} .panel-state`);
  await check('the active agent reads Suspended', await until(async () => (await chipA.innerText().catch(() => '')) === 'Suspended'), () => chipA.innerText().catch(() => ''));
  const ticketA = page.locator(`${panel('lim-a')} .panel-ticket`);
  await check('its ticket chip shows the limit suspension', await until(async () => (await classesOf(ticketA)).includes('suspended_limit')), async () => (await classesOf(ticketA)).join(' '));
  await check('both tickets are suspended_limit', ticketFile('lim-a')?.status === 'suspended_limit' && ticketFile('lim-b')?.status === 'suspended_limit', () => JSON.stringify([ticketFile('lim-a')?.status, ticketFile('lim-b')?.status]));
  await check('the main terminal still runs', (await state()).main.status === 'running');

  // 100% with the same reset: still the one sleep until resetsAt, with a countdown and a Resume now button
  await quota(100, resetsAt);
  await check('the status bar shows the pause and a countdown', await until(async () => /Usage limit almost used up: agents paused until .*\(0:(09|10):\d\d\)/.test(await bar.innerText())), () => bar.innerText());
  await check('the Resume now button is visible', await page.locator('#statusbar .statusbar-resume').isVisible());
  await page.click('#new-agent-btn');
  await page.fill('input[name="slug"]', 'lim-c');
  await page.click('.new-agent-form button[type="submit"]');
  await check('a new agent from the UI stays queued', await until(async () => (await agentOf('lim-c'))?.state === 'queued'), async () => JSON.stringify(await agentOf('lim-c')));
  const launchesOf = () => ['shop-api', 'lim-a', 'lim-b', 'lim-c'].map((x) => s.lastLaunchArgs(x));
  const before = launchesOf();
  await sleep(3000);
  const during = launchesOf();
  await check('zero launches during the sleep', during.every((a, i) => a === before[i]) && during[3] === undefined && (await agentOf('lim-c'))?.state === 'queued');
  const wakeCount = async () => (await inbox('shop-api')).filter((m) => m.startsWith('The subscription limit was reset')).length;
  await check('no wake-up message before the reset', (await wakeCount()) === 0);

  // the reset: exactly one wake-up message to the main, nothing else starts
  fake.advance(10 * 60_000 + 10_000);
  await check('exactly one wake-up message reaches the main', await until(async () => (await wakeCount()) === 1) && (await sleep(1000), (await wakeCount()) === 1), async () => String(await wakeCount()));
  const after = launchesOf();
  await check('no agent starts by itself at the reset (and the running main is not relaunched)', after.every((a, i) => a === before[i]) && ticketFile('lim-a')?.status === 'suspended_limit' && ticketFile('lim-b')?.status === 'suspended_limit');
  // the main's next turn reports the new window: the probe ends and the console is awake
  await quota(10);
  await check('a low reading ends the sleep', await until(async () => (await state()).sleep === undefined), async () => JSON.stringify((await state()).sleep));
  await check('the suspended agents still wait for the main', ticketFile('lim-a')?.status === 'suspended_limit' && ticketFile('lim-b')?.status === 'suspended_limit' && s.lastLaunchArgs('lim-a') === before[1]);

  // the test plays the main: resume_agent
  const res = await tool('shop-api', 'resume_agent', { names: ['lim-a'] });
  await check('resume_agent starts lim-a', res.json.status === 'ok' && JSON.stringify(res.json.started) === '["lim-a"]', () => JSON.stringify(res.json));
  await check('lim-a starts again with --resume of its session', await until(() => { const a = s.lastLaunchArgs('lim-a'); return a !== before[1] && !!a && a.includes('--resume') && a[a.indexOf('--resume') + 1] === 'sess-lim-a'; }), () => JSON.stringify(s.lastLaunchArgs('lim-a')));
  await check('its ticket is in_progress and its process runs', await until(async () => ticketFile('lim-a')?.status === 'in_progress' && (await agentOf('lim-a'))?.status === 'running'), async () => JSON.stringify({ t: ticketFile('lim-a')?.status, a: await agentOf('lim-a') }));
  await quota(88);
  await until(async () => (await state()).quota?.percent === 88);
  const res2 = await tool('shop-api', 'resume_agent', { names: ['lim-b'] });
  await check('a second resume_agent at 88% is refused quota_high', res2.json.status === 'refused' && res2.json.code === 'quota_high', () => JSON.stringify(res2.json));
  await check('and lim-b stays suspended', ticketFile('lim-b')?.status === 'suspended_limit' && s.lastLaunchArgs('lim-b') === before[2]);
});

// Block D, the roles a stop must not strand: a reviewer running at 95% gives its ticket back (delivered) and the main is told to
// ask again; the delivered author's branch is not moved by a WIP commit
scenario('limit-reviewer', async () => {
  const { s, t, event, tool, spawn, inbox, agentOf, ticketFile } = await boot();
  const projectFile = join(t.repo, '.andromedacli', 'project.json');
  writeFileSync(projectFile, JSON.stringify({ ...JSON.parse(readFileSync(projectFile, 'utf8')), testCommand: 'node -e "process.exit(0)"' }));
  const page = await open(`${s.url}/?token=${s.token}`);
  await until(async () => (await page.locator(`${panel('shop-api')} .xterm`).count()) > 0);
  const started = await spawn('rev-t', 'Add a helper', 400_000);
  await check('spawn starts rev-t', started.json.status === 'started', () => JSON.stringify(started.json));
  const wt = worktreeOf(t, 'rev-t');
  await event('rev-t', 'session.start', { cwd: wt });
  await tool('rev-t', 'checklist_set', { items: ITEMS });
  writeFileSync(join(wt, 'helper.js'), 'module.exports = {};\n');
  let closed = true;
  for (let n = 1; n <= 6; n++) {
    if (n === 6) writeFileSync(join(wt, 'README.md'), 'docs\n');
    const r = await tool('rev-t', 'step_done', { n, note: 'a decent note for this step' });
    closed &&= r.json.status === 'closed';
  }
  await check('rev-t delivers its ticket', closed && ticketFile('rev-t')?.status === 'delivered', () => JSON.stringify(ticketFile('rev-t')));
  const rr = await tool('shop-api', 'request_review', { name: 'rev-t' });
  await check('request_review starts the reviewer', rr.json.status === 'ok' && rr.json.reviewer === 'review-rev-t', () => JSON.stringify(rr.json));
  await check('the reviewer runs', await until(async () => (await agentOf('review-rev-t'))?.status === 'running'), async () => JSON.stringify(await agentOf('review-rev-t')));
  const head = gitSync(wt, 'rev-parse', 'HEAD');
  writeFileSync(join(wt, 'stray.txt'), 'not part of the delivery\n');
  await event('shop-api', 'quota', { rateLimits: [{ kind: 'five_hour', percentUsed: 96 }] });
  await check('the reviewer is ended', await until(async () => (await agentOf('review-rev-t'))?.status === 'exited'), async () => JSON.stringify(await agentOf('review-rev-t')));
  await check('its ticket is delivered again (not stuck in review)', await until(() => ticketFile('rev-t')?.status === 'delivered' && ticketFile('rev-t')?.reviewer === undefined), () => JSON.stringify(ticketFile('rev-t')));
  await check('the main is told to call request_review again', await until(async () => (await inbox('shop-api')).some((m) => m.includes('review-rev-t') && m.includes('request_review'))));
  await check('the delivered branch did not move (no WIP commit of a delivered author)', gitSync(wt, 'rev-parse', 'HEAD') === head, () => gitSync(wt, 'log', '-1', '--format=%s'));
});

// Block D, SPEC 18.5: the weekly limit wakes nobody; the user gets an item in the queue with the choices, and the status bar the date
scenario('weekly', async () => {
  const fake = manualClock();
  const { s, event, asUi } = await boot({ sleepClock: fake.clock });
  const page = await open(`${s.url}/?token=${s.token}`);
  await until(async () => (await page.locator(`${panel('shop-api')} .xterm`).count()) > 0);
  const resetsAt = new Date(fake.now() + 3 * 24 * 60 * 60_000).toISOString();
  await event('shop-api', 'quota', { rateLimits: [{ kind: 'seven_day', percentUsed: 100, resetsAt }] });
  const bar = page.locator('#statusbar');
  await check('the status bar shows the weekly pause', await until(async () => (await bar.innerText()).includes('Weekly limit almost used up')), () => bar.innerText());
  const hourOnly = new Date(resetsAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const text = await bar.innerText();
  await check('with the date of the reset, not only the hour', !text.includes(`paused until ${hourOnly}.`), () => text);
  await check('no timer: nothing restarts by itself', (await asUi('/api/state')).json.sleep?.weekly === true);
  await page.keyboard.press('Alt+Q');
  const item = page.locator('#drawer .queue-weekly');
  await check('the queue shows one weekly item', await until(async () => (await item.count()) === 1));
  await check('it lists the choices', /wait until the reset.*fewer agents or a cheaper model.*stop the projects/s.test(await item.innerText()), () => item.innerText());
  const answers = await item.locator('button').evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.answer));
  await check('with one button', JSON.stringify(answers) === JSON.stringify(['ok']), () => JSON.stringify(answers));
  await event('shop-api', 'quota', { rateLimits: [{ kind: 'seven_day', percentUsed: 100, resetsAt }] });
  await sleep(500);
  await check('the same reading again adds no second item', (await item.count()) === 1);
  await item.locator('button').click();
  await check('acknowledged, the queue is empty', await until(async () => (await page.locator('#drawer .queue-item').count()) === 0));
});

try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const sc of scenarios) {
    console.log(`\n# ${sc.name}`);
    try { await sc.run(); } catch (err) { failures++; console.log(`FAIL  scenario ${sc.name} threw: ${(err as Error).stack ?? err}`); }
    finally { await runCleanup(); }
  }
} catch (err) {
  failures++;
  console.log(`FAIL  run aborted: ${(err as Error).stack ?? err}`);
} finally {
  await runCleanup();
  await browser?.close().catch(() => {});
  await sleep(500);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
