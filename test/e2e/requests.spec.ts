// Requests between agents acceptance (SPEC 10): Edge against a real server, a real temporary git repository with a bare remote,
// fake agent processes and a "fake mod" that speaks /v1 with each session's own token.
//   1. FE asks BE (which asks the DBA) and keeps working; the chips and the Requests drawer follow;
//   2. the answers unlock the step, and its comment must go before the step closes.
// Run with: npx tsx test/e2e/requests.spec.ts (after `npm run build`).
import { chromium } from 'playwright-core';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeRepo } from '../git-helpers';

process.env.CONSOLE_TEST = '1';
const { startServer } = await import('../../src/server/index');

const root = resolve(import.meta.dirname, '..', '..');
const fixture = join(root, 'test', 'fixtures', 'fake-agent.cjs').replace(/\\/g, '/');
let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label} ${detail}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => Promise<boolean> | boolean, ms = 15000): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await f()) return true; await sleep(50); }
  return false;
}
const ITEMS = ['Study the code', 'Tests first: ordering', 'Implement a', 'Implement b', 'Validation: run the suite', 'Update documentation'];

const t = makeRepo({ remote: true });
const configDir = mkdtempSync(join(tmpdir(), 'e2e-req-cfg-'));
const shots = mkdtempSync(join(tmpdir(), 'e2e-req-shots-'));
writeFileSync(join(configDir, 'config.json'), JSON.stringify({ schema: 1, language: 'en', git: { worktrees: true } }));
const s = await startServer({ port: 0, projectRoot: t.repo, configDir, projectName: 'shop-api', claudeCommand: [process.execPath, fixture], modDir: null });
const projectFile = join(t.repo, '.andromedaconsole', 'project.json');
writeFileSync(projectFile, JSON.stringify({ ...JSON.parse(readFileSync(projectFile, 'utf8')), testCommand: 'node -e "process.exit(0)"' }));

const call = async (token: string | undefined, path: string, method = 'GET', body?: unknown) => {
  const r = await fetch(`${s.url}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try { json = await r.json(); } catch { /* 204 */ }
  return { status: r.status, json };
};
const tool = (slug: string, name: string, body: unknown) => call(s.sessionTokenFor(slug), `/v1/tools/${name}`, 'POST', body);
const panel = (slug: string) => `.panel[data-slug="${slug}"]`;
const worktreeOf = (slug: string): string => join(t.repo, '.andromedaconsole', 'worktrees', slug);

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, locale: 'en-US' });
  await page.goto(`${s.url}/?token=${s.token}`);
  await until(async () => (await page.locator(`${panel('shop-api')} .xterm`).count()) > 0);

  // 1. Three agents, a checklist each, steps 1-2 closed
  for (const slug of ['db-model', 'be-orders', 'fe-pages']) {
    const started = await tool('shop-api', 'spawn_agent', { name: slug, profile: 'developer', goal: `work as ${slug}` });
    check(`${slug} starts`, started.json.status === 'started', JSON.stringify(started.json));
    check(`${slug} saves a checklist`, (await tool(slug, 'checklist_set', { items: ITEMS })).json.status === 'ok');
    await tool(slug, 'step_done', { n: 1, note: 'study notes for the step' });
    await tool(slug, 'step_done', { n: 2 });
  }

  // 2. FE asks BE and leaves a comment; BE asks the DBA because of it
  const q1 = await tool('fe-pages', 'send_message', { type: 'question', to: 'be-orders', text: 'REST signatures of POST /orders?', step: 3 });
  check('the question returns an id at once', q1.json.status === 'ok' && /^TODO-[0-9a-f]{6}$/.test(q1.json.requestId), JSON.stringify(q1.json));
  const id1: string = q1.json.requestId;
  const q2 = await tool('be-orders', 'send_message', { type: 'question', to: 'db-model', text: 'Which columns does the orders table have?', because: id1 });
  check('a question needed to answer the first one is accepted as the next link of the chain', q2.json.status === 'ok', JSON.stringify(q2.json));
  const id2: string = q2.json.requestId;
  check('asking back along the chain is a cycle', (await tool('db-model', 'send_message', { type: 'question', to: 'fe-pages', text: 'x', because: id2 })).json.code === 'cycle');

  const waitChip = page.locator(`${panel('fe-pages')} .panel-requests.waiting`);
  check('fe-pages shows that it waits for be-orders and which comment to look for',
    await until(async () => /waiting for be-orders \(TODO-[0-9a-f]{6}\)/.test(await waitChip.innerText().catch(() => ''))), await waitChip.innerText().catch(() => ''));
  const owedChip = page.locator(`${panel('be-orders')} .panel-requests.owed`);
  check('be-orders shows that it owes an answer to fe-pages',
    await until(async () => /to answer for fe-pages \(TODO-[0-9a-f]{6}\)/.test(await owedChip.innerText().catch(() => ''))), await owedChip.innerText().catch(() => ''));
  const button = page.locator('#requests-btn');
  check('the header offers the requests with their number', await until(async () => (await button.isVisible()) && (await button.innerText()) === 'Requests (2)'), await button.innerText().catch(() => ''));
  await button.click();
  check('the drawer lists both requests as open', await until(async () => (await page.locator('#requests .request-item').count()) === 2 && (await page.locator('#requests .request-state.open').count()) === 2));
  await page.screenshot({ path: join(shots, 'requests-open.png') });
  console.log(`INFO  screenshot: ${join(shots, 'requests-open.png')}`);

  // 3. FE goes on past the waiting step; its comment is in the code; the validation is refused
  writeFileSync(join(worktreeOf('fe-pages'), 'orders.ts'), `// ${id1} signature of POST /orders\n`);
  check('fe-pages closes step 4 past the waiting step 3', (await tool('fe-pages', 'step_done', { n: 4 })).json.status === 'closed');
  check('fe-pages cannot validate while step 3 waits', (await tool('fe-pages', 'step_done', { n: 5 })).json.code === 'pending_requests');
  // BE cannot validate while the question is open
  for (const n of [3, 4]) await tool('be-orders', 'step_done', { n, note: 'notes for the step' });
  check('be-orders cannot validate while it owes an answer', (await tool('be-orders', 'step_done', { n: 5 })).json.code === 'unanswered_requests');

  // 4. The answers: db-model, then be-orders; the chips go and the drawer says Answered
  check('db-model answers', (await tool('db-model', 'send_message', { type: 'answer', in_reply_to: id2, text: 'id, sku, qty, created_at' })).json.status === 'ok');
  check('a second answer is refused', (await tool('db-model', 'send_message', { type: 'answer', in_reply_to: id2, text: 'again' })).json.code === 'already_closed');
  check('be-orders answers', (await tool('be-orders', 'send_message', { type: 'answer', in_reply_to: id1, text: 'POST /orders {sku, qty} -> 201 {id}' })).json.status === 'ok');
  check('the chip of fe-pages goes away', await until(async () => await waitChip.isHidden()));
  check('the chip of be-orders goes away', await until(async () => await owedChip.isHidden()));
  check('the drawer reads Answered for both', await until(async () => (await page.locator('#requests .request-state.answered').count()) === 2));
  check('be-orders can now validate', (await tool('be-orders', 'step_done', { n: 5 })).json.status === 'closed');

  // 5. The comment must go before the step closes
  const early = await tool('fe-pages', 'step_done', { n: 3 });
  check('step 3 is refused while its comment is in the code', early.json.code === 'todo_left' && JSON.stringify(early.json.files) === JSON.stringify(['orders.ts:1']), JSON.stringify(early.json));
  rmSync(join(worktreeOf('fe-pages'), 'orders.ts'));
  check('step 3 closes once the comment is gone', (await tool('fe-pages', 'step_done', { n: 3 })).json.status === 'closed');
  check('fe-pages can now validate', (await tool('fe-pages', 'step_done', { n: 5 })).json.status === 'closed');
  await page.screenshot({ path: join(shots, 'requests-answered.png') });
  console.log(`INFO  screenshot: ${join(shots, 'requests-answered.png')}`);
  await page.close();
} finally {
  await browser.close();
  await s.close();
  await sleep(500);
  for (const dir of [t.base, configDir]) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* temp files */ } }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
