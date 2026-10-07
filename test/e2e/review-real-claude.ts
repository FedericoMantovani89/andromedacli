// Manual contract test with the REAL Claude Code for Phase 4 (costs quota: a main, an author and one or two reviewers on haiku).
// Run: npx tsx test/e2e/review-real-claude.ts <already-trusted-folder>
// A scratch repository (with a bare remote) is created INSIDE that folder, so the worktrees next to it inherit its trust.
// Proves what fakes cannot: a real reviewer, in its read-only checkout, reads a real delivered diff and calls review_verdict; a
// failed review reaches the real author as a message from the main and the author fixes it through the reopened steps; the main
// merges and proposes the release by itself; the user's approval from the queue pushes main; and the main cannot push main itself.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CONSOLE_TEST = '1';
const { startServer } = await import('../../src/server/index');
const trusted = process.argv[2];
if (!trusted) throw new Error('usage: review-real-claude.ts <trusted-folder>');

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// ---- scratch repository: a tiny project, an origin, one commit ----
const scratch = mkdtempSync(join(trusted, 'revreal-'));
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
writeFileSync(join(repo, 'src', 'stats.js'), 'function sum(list) { return list.reduce((a, b) => a + b, 0); }\nmodule.exports = { sum };\n');
writeFileSync(join(repo, 'test', 'stats.test.js'), "const test = require('node:test');\nconst assert = require('node:assert');\nconst { sum } = require('../src/stats');\ntest('sum', () => assert.strictEqual(sum([1, 2, 3]), 6));\n");
writeFileSync(join(repo, 'README.md'), '# tiny\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'init');
git(repo, 'remote', 'add', 'origin', remote);
git(repo, 'push', '-q', 'origin', 'main');

const configDir = mkdtempSync(join(tmpdir(), 'revreal-cfg-'));
writeFileSync(join(configDir, 'config.json'), JSON.stringify({
  schema: 1, language: 'en', agents: { bypassPermissions: true }, guard: { mode: 'enforce' }, claude: { command: ['claude', '--model', 'haiku'] },
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ESC = String.fromCharCode(27);
const strip = (t: string) => t.replace(new RegExp(`${ESC}\\[[0-9;?<>=]*[ -/]*[@-~]`, 'g'), '').replace(new RegExp(`${ESC}\\][^\\x07]*\\x07`, 'g'), '');
async function until(f: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await f()) return true; await sleep(2000); }
  return false;
}

const started = Date.now();
const s = await startServer({ port: 0, projectRoot: repo, configDir, projectName: 'revreal' });
writeFileSync(join(repo, '.console', 'project.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(repo, '.console', 'project.json'), 'utf8')), testCommand: 'node --test' }));
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
  s.writeToSession(slug, String.fromCharCode(13));
}
const ticket = (slug: string): any => {
  const f = join(repo, '.console', 'state', 'tickets', `${slug}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : undefined;
};
const queue = async (): Promise<any[]> => (await ui('/api/state')).queue as any[];
async function diagnose(label: string, slugs: string[]): Promise<void> {
  const st = await ui('/api/state');
  for (const slug of slugs) console.log(`INFO  ${label} ${slug} terminal tail: ${JSON.stringify((await snapshot(slug)).slice(-700))}`);
  console.log(`INFO  agents: ${JSON.stringify(st.agents.map((a: any) => [a.slug, a.state, a.ticket?.status]))} queue: ${JSON.stringify(st.queue.map((q: any) => [q.kind, q.text]))}`);
}

// Every new repository asks "do you trust this folder" in its first terminal; a person would press the key.
const trustAnswered = new Set<string>();
let stopTrusting = false;
const trustLoop = (async () => {
  while (!stopTrusting) {
    const slugs = ['revreal', ...(((await ui('/api/state')).agents as { slug: string }[]).map((a) => a.slug))];
    for (const slug of slugs) {
      if (trustAnswered.has(slug)) continue;
      if ((await snapshot(slug)).includes('Yes, I trust this folder')) {
        trustAnswered.add(slug);
        s.writeToSession(slug, `${ESC}[B`);
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
  rec('the main starts with the real TUI', await until(async () => (await snapshot('revreal')).includes('Claude Code'), 90_000));
  await sleep(8000);

  // ---- 1. The main starts an author. The objective asks for more than the author is told to do (the empty list), so the main's
  //         own check has something to send back: that is what exercises the rework loop with a real author, deterministically. ----
  await type('revreal', 'Use the console tool to start an agent named add-average with profile backend and the goal: in src/stats.js add and export a function average(list) that returns the sum of the list divided by the number of items, and add a test for it in test/stats.test.js in the node:test style already used there. For this exercise keep average minimal and do not handle an empty list yet. Then tell me it was started. When the ticket is delivered do exactly this: call ticket_report; then send the ticket back with send_back_ticket and the note "average([]) must return 0 and must have a test; the objective requires it"; do not request a review yet. When it is delivered again: call ticket_report, request the review with request_review, merge it with merge_ticket when the review passes, and when it is merged call propose_release. Do not ask me questions.');
  const spawned = await until(async () => ((await ui('/api/state')).agents as { slug: string }[]).some((a) => a.slug === 'add-average'), 240_000);
  rec('main started the author', spawned);
  if (!spawned) { await diagnose('no author', ['revreal']); throw new Error('the main did not start the author'); }
  const delivered = await until(() => ticket('add-average')?.status === 'delivered' || (ticket('add-average')?.verdicts?.length ?? 0) > 0, 900_000);
  rec('the author closed every step and the ticket was delivered', delivered, delivered ? `${ticket('add-average').steps.length} steps` : JSON.stringify(ticket('add-average')?.steps?.map((x: any) => [x.n, x.done])));
  if (!delivered) { await diagnose('not delivered', ['revreal', 'add-average']); throw new Error('the ticket was not delivered'); }

  // ---- 2. The main checks the delivery and sends it back with its own note (no reviewer needed) ----
  const sentBack = await until(() => ticket('add-average')?.verdicts?.[0]?.reviewer === 'main' || (ticket('add-average')?.round ?? 0) > 0, 480_000);
  rec('the main sent the ticket back with its own note (ticket_report, then send_back_ticket)', sentBack, JSON.stringify({ status: ticket('add-average')?.status, round: ticket('add-average')?.round }));
  if (!sentBack) { await diagnose('not sent back', ['revreal']); throw new Error('the main did not send the ticket back'); }
  rec('the report was written by the console', existsSync(join(repo, '.console', 'tickets', 'add-average', 'report.md')));
  rec('the ticket reopened for the author with three new steps', ticket('add-average').round === 1 && ticket('add-average').steps.length >= 8 && /\(round 1\)/.test(ticket('add-average').steps.at(-1).title), JSON.stringify(ticket('add-average').steps.map((x: any) => x.title).slice(-3)));

  // ---- 3. The real author fixes it through the reopened steps and delivers again ----
  const redelivered = await until(() => ['delivered', 'in_review', 'approved', 'merged', 'released'].includes(ticket('add-average')?.status) && (ticket('add-average')?.round ?? 0) >= 1, 900_000);
  rec('the author worked through the reopened steps and the ticket was delivered again', redelivered, JSON.stringify({ status: ticket('add-average')?.status, steps: ticket('add-average')?.steps?.map((x: any) => [x.n, x.done]) }));
  if (!redelivered) { await diagnose('no redelivery', ['add-average', 'revreal']); throw new Error('no redelivery'); }

  // ---- 4. A real reviewer judges the fixed work (the main requests it by itself); a failure would loop back to the author ----
  const reviewed = await until(() => (ticket('add-average')?.verdicts ?? []).some((v: any) => String(v.reviewer).startsWith('review-')), 900_000);
  rec('a real reviewer gave a verdict through review_verdict', reviewed, JSON.stringify(ticket('add-average')?.verdicts?.map((v: any) => [v.reviewer, v.pass])));
  if (!reviewed) { await diagnose('no verdict', ['revreal', 'add-average']); throw new Error('no verdict'); }
  const real = ticket('add-average').verdicts.find((v: any) => String(v.reviewer).startsWith('review-'));
  console.log(`INFO  reviewer verdict: pass=${real.pass} reviewer=${real.reviewer} notes=${JSON.stringify(real.notes).slice(0, 400)}`);
  rec('the reviewer changed no file', !existsSync(join(scratch, 'my repo', '.console', 'worktrees', real.reviewer)) || git(join(scratch, 'my repo', '.console', 'worktrees', real.reviewer), 'status', '--porcelain', '--untracked-files=no') === '');

  // ---- 5. Merge: the main does it by itself when the review passed (a failed review reworks; after the rounds the user decides) ----
  const deadline = Date.now() + 900_000;
  while (Date.now() < deadline && !['merged', 'released'].includes(ticket('add-average')?.status)) {
    if (ticket('add-average')?.status === 'needs_user') {
      const q = (await queue()).find((x) => x.kind === 'decision');
      if (q) { await ui(`/api/queue/${q.id}/answer`, 'POST', { answer: 'approve' }); await type('revreal', 'The user approved ticket add-average. Merge it now with merge_ticket and then call propose_release.'); }
    }
    await sleep(3000);
  }
  const merged = ['merged', 'released'].includes(ticket('add-average')?.status);
  rec('the main merged the approved ticket into the project branch by itself', merged, String(ticket('add-average')?.status));
  if (!merged) { await diagnose('not merged', ['revreal']); throw new Error('not merged'); }
  const projectLog = git(repo, 'log', '--format=%s', 'project/revreal');
  rec('the project branch has one squash commit for the ticket', projectLog.split('\n')[0]!.startsWith('ticket add-average:'), projectLog.split('\n')[0]);
  rec('the author session ended and its folder is gone', await until(async () => !existsSync(join(scratch, 'my repo', '.console', 'worktrees', 'add-average')) && (((await ui('/api/state')).agents as any[]).find((a) => a.slug === 'add-average')?.state === 'finished'), 60_000));
  let emptyList = '';
  try { emptyList = execFileSync('node', ['-e', "console.log(String(require('./src/stats').average([])))"], { cwd: join(scratch, 'my repo', '.console', 'worktrees', '.project'), encoding: 'utf8' }).trim(); } catch { /* reported below */ }
  rec('the merged code does what the main\'s note asked: average([]) is 0', emptyList === '0', emptyList);
  let testsPass = true;
  try { execFileSync('node', ['--test'], { cwd: join(scratch, 'my repo', '.console', 'worktrees', '.project'), stdio: 'ignore' }); } catch { testsPass = false; }
  rec('the project branch passes its tests', testsPass);

  // ---- 6. Release: the main proposes, the user approves from the queue, the console pushes ----
  await type('revreal', 'Now call propose_release so the user can approve the release to origin/main.');
  const asked = await until(async () => (await queue()).some((q) => q.kind === 'confirm'), 300_000);
  rec('the main proposed the release: one confirmation in the queue', asked);
  if (asked) {
    const q = (await queue()).find((x) => x.kind === 'confirm')!;
    rec('it carries the ticket, its report and the test result', q.payload.tickets.some((t: any) => t.slug === 'add-average' && /Objective|Obiettivo/.test(t.report)) && q.payload.tests?.ok === true);
    const remoteBefore = git(remote, 'rev-parse', 'main');
    await ui(`/api/queue/${q.id}/answer`, 'POST', { answer: 'approve' });
    rec('Approve moved origin/main to the project tip', await until(() => git(remote, 'rev-parse', 'main') === git(repo, 'rev-parse', 'project/revreal') && git(remote, 'rev-parse', 'main') !== remoteBefore, 120_000));
    rec('the ticket is released', await until(() => ticket('add-average')?.status === 'released', 60_000));
  }

  // ---- 7. The main cannot push main itself (guard; the pre-push hook is the second layer) ----
  const before = git(remote, 'rev-parse', 'main');
  await type('revreal', 'Run exactly this command with the Bash tool: git push --force origin main . Then reply with exactly: push=<denied or ok>, depending on whether the tool call was refused.');
  const guardLog = (): string => { const f = join(repo, '.console', 'state', 'guard.jsonl'); return existsSync(f) ? readFileSync(f, 'utf8') : ''; };
  // The proof is the guard's own log (the model's wording varies); the main's reply is shown for information.
  const refused = await until(() => guardLog().split('\n').some((l) => l.includes('"slug":"revreal"') && l.includes('git.force')), 420_000);
  rec('the main\'s own forced push of main was refused by the guard', refused, refused ? '' : guardLog().slice(-300));
  console.log(`INFO  main reply: ${JSON.stringify((await answers('revreal')).slice(-300))}`);
  rec('origin/main did not move', git(remote, 'rev-parse', 'main') === before);

  for (const slug of ['revreal', 'add-average']) {
    const text = await snapshot(slug);
    const hits = text.split(String.fromCharCode(10)).filter((l) => /Do you want to proceed|Allow this|requires approval/i.test(l)).map((l) => l.trim()).slice(0, 3);
    rec(`no permission dialog is waiting in the terminal of ${slug}`, hits.length === 0, hits.join(' | '));
  }
} catch (e) {
  console.log(`ABORT ${e instanceof Error ? e.message : e}`);
  results.push(['aborted', false]);
} finally {
  stopTrusting = true;
  await trustLoop;
  await s.close();
  await sleep(1500);
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
const failed = results.filter(([, ok]) => !ok).length;
console.log(`${failed === 0 ? 'REAL REVIEW CONTRACT PASSED' : `${failed} FAILED`} in ${Math.round((Date.now() - started) / 1000)} s`);
process.exit(failed === 0 ? 0 : 1);
