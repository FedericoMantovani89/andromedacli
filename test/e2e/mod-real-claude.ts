// Manual contract test with the REAL Claude Code and the REAL mod (costs a little quota: a main and two agents on haiku).
// Run: npx tsx test/e2e/mod-real-claude.ts <already-trusted-project-folder>
// It proves what simulated events cannot: the engine loads the mod in a console-launched session, deferred tools are found
// when named, a goal reaches an idle agent through the inbox, and questions travel through the console queue.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CONSOLE_TEST = '1';
const { startServer } = await import('../../src/server/index');
const projectRoot = process.argv[2];
if (!projectRoot) throw new Error('usage: mod-real-claude.ts <trusted-folder>');

const configDir = mkdtempSync(join(tmpdir(), 'real-cfg-'));
writeFileSync(join(configDir, 'config.json'), JSON.stringify({ schema: 1, language: 'en', git: { worktrees: false }, claude: { command: ['claude', '--model', 'haiku'] } }));
rmSync(join(projectRoot, '.andromedacli'), { recursive: true, force: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ESC = String.fromCharCode(27);
const strip = (t: string) => t.replace(new RegExp(`${ESC}\\[[0-9;?<>=]*[ -/]*[@-~]`, 'g'), '').replace(new RegExp(`${ESC}\\][^\\x07]*\\x07`, 'g'), '');
async function until(f: () => Promise<boolean>, ms: number): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await f()) return true; await sleep(1000); }
  return false;
}

const started = Date.now();
const s = await startServer({ port: 0, projectRoot, configDir, projectName: 'modtest' });
const ui = async (path: string, method = 'GET', body?: unknown) => {
  const r = await fetch(`${s.url}${path}`, {
    method, headers: { authorization: `Bearer ${s.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  return r.json() as Promise<any>;
};
const snapshot = async (slug: string) => strip((await ui(`/api/debug/snapshot/${slug}`)).text ?? '');
const answers = async (slug: string): Promise<string> => ((await ui(`/api/reading/${slug}`)).entries as { text: string }[]).map((e) => e.text).join('\n---\n');
/** Types into a session like a person: text, a pause (so it is not taken for a paste), then Enter. */
async function type(slug: string, text: string): Promise<void> {
  s.writeToSession(slug, text);
  await sleep(1000);
  s.writeToSession(slug, '\r');
}

const results: [string, boolean][] = [];
const rec = (label: string, ok: boolean, detail = '') => { results.push([label, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} ${detail}`); };

try {
  rec('the main starts with the real TUI', await until(async () => (await snapshot('modtest')).includes('Claude Code'), 90000));
  await sleep(4000);

  // 1. The main finds the deferred tools by their full name, starts an agent, and the goal reaches it through the inbox
  await type('modtest', 'Use the console tool to start an agent named hello-agent with profile developer and the goal: reply with the single word hello-from-agent and nothing else. Then tell me it was started.');
  rec('main called spawn_agent: the agent appears in the console', await until(async () => ((await ui('/api/state')).agents as { slug: string }[]).some((a) => a.slug === 'hello-agent'), 240000));
  const agentWorked = await until(async () => (await answers('hello-agent')).includes('hello-from-agent'), 240000);
  rec('the agent received its goal from the inbox, worked, and its answer reached the read store', agentWorked, agentWorked ? '' : `reading: ${(await answers('hello-agent')).slice(0, 200)}`);
  const stateAfter = (await ui('/api/state')).agents.find((a: { slug: string }) => a.slug === 'hello-agent');
  rec('the agent is Idle after finishing (state from events)', stateAfter?.state === 'idle', JSON.stringify(stateAfter));
  rec('the main answered too (turn.complete reached the read store)', await until(async () => (await answers('modtest')).length > 0, 120000));

  // 2. The main asks the human through the queue
  await type('modtest', 'Use the console ask_user tool to ask me which color I prefer, with the options Red and Blue. After I answer, reply with exactly: color=<my answer>.');
  let qid = '';
  rec('ask_user puts the question in the queue', await until(async () => { const q = (await ui('/api/state')).queue as { id: string; from: string }[]; qid = q.find((x) => x.from === 'modtest')?.id ?? ''; return qid !== ''; }, 240000));
  if (qid) await ui(`/api/queue/${qid}/answer`, 'POST', { answer: 'Blue' });
  const colorOk = await until(async () => (await answers('modtest')).includes('color=Blue'), 240000);
  rec('the answer reached the waiting main tool call', colorOk, colorOk ? '' : (await answers('modtest')).slice(-300));

  // 3. An agent's native AskUserQuestion is intercepted and goes through the same queue
  await type('modtest', 'Start an agent named fruit-agent with profile developer and the goal: use the AskUserQuestion tool to ask which fruit I prefer, Apple or Pear, then reply with exactly: fruit=<the answer you received>.');
  let fid = '';
  rec('the agent question appears in the console queue', await until(async () => { const q = (await ui('/api/state')).queue as { id: string; from: string }[]; fid = q.find((x) => x.from === 'fruit-agent')?.id ?? ''; return fid !== ''; }, 300000));
  if (fid) await ui(`/api/queue/${fid}/answer`, 'POST', { answer: 'Pear' });
  const fruitOk = await until(async () => (await answers('fruit-agent')).includes('fruit=Pear'), 240000);
  rec('the agent received the answer from the console', fruitOk, fruitOk ? '' : (await answers('fruit-agent')).slice(-300));
  // 4. A long answer arrives whole in the read store (the engine does not truncate turn.complete.answer)
  await type('modtest', 'Without using any tool, write the integers from 1 to 3000 separated by single spaces, nothing else.');
  const longOk = await until(async () => { const a = await answers('modtest'); return /(^|\s)3000\s*$/.test(a.trim()); }, 240000);
  rec('a long answer (about 14 KB) reaches the read store complete', longOk, longOk ? '' : `ends with: ${(await answers('modtest')).trim().slice(-60)}`);
  if (!longOk) {
    const entries = ((await ui('/api/reading/modtest')).entries as { n: number; text: string }[]).map((e) => `#${e.n}(${e.text.length}b)`);
    console.log(`INFO  main entries: ${entries.join(' ')}`);
    console.log(`INFO  main state: ${JSON.stringify((await ui('/api/state')).main)}`);
    console.log(`INFO  main terminal tail: ${JSON.stringify((await snapshot('modtest')).slice(-700))}`);
  }
  // 5. An agent's permission prompt (a Bash redirect is not pre-approved) is routed to the console queue; the answer is the verdict
  await type('modtest', 'Start an agent named file-agent with profile developer and the goal: use the Bash tool to run exactly this command: echo permtest > permtest.txt then reply with exactly result=ok if it ran, or result=denied if the tool was refused.');
  let pid = '';
  const pending = async (from: string) => ((await ui('/api/state')).queue as { id: string; from: string; kind: string; tool?: string; detail?: string }[]).find((x) => x.from === from && x.kind === 'permission');
  rec('the agent permission request appears in the console queue (not stuck in its terminal)', await until(async () => { const p = await pending('file-agent'); pid = p?.id ?? ''; return Boolean(p); }, 300000));
  const perm = await pending('file-agent');
  rec('it names the tool and shows the command', perm?.tool === 'Bash' && (perm?.detail ?? '').includes('permtest.txt'), JSON.stringify(perm));
  if (pid) await ui(`/api/queue/${pid}/answer`, 'POST', { answer: 'allow' });
  const allowed = await until(async () => (await answers('file-agent')).includes('result=ok'), 240000);
  rec('Allow from the console lets the tool run', allowed, allowed ? '' : (await answers('file-agent')).slice(-300));

  await type('modtest', 'Start an agent named deny-agent with profile developer and the goal: use the Bash tool to run exactly this command: echo denytest > denytest.txt then reply with exactly result=ok if it ran, or result=denied if the tool was refused.');
  let did = '';
  rec('a second permission request arrives', await until(async () => { const p = await pending('deny-agent'); did = p?.id ?? ''; return Boolean(p); }, 300000));
  if (did) await ui(`/api/queue/${did}/answer`, 'POST', { answer: 'deny' });
  const denied = await until(async () => (await answers('deny-agent')).includes('result=denied'), 240000);
  rec('Deny from the console refuses the tool and the agent knows', denied, denied ? '' : (await answers('deny-agent')).slice(-300));

  // Diagnostic: any permission prompt left in a terminal means a tool the console did not pre-approve
  for (const slug of ['modtest', 'hello-agent', 'fruit-agent', 'file-agent', 'deny-agent']) {
    const text = await snapshot(slug);
    const hits = text.split(String.fromCharCode(10)).filter((l) => /Do you want to proceed|Allow this|requires approval/i.test(l)).map((l) => l.trim()).slice(0, 4);
    rec(`no permission prompt is waiting in ${slug}`, hits.length === 0, hits.join(' | '));
  }
} finally {
  await s.close();
  rmSync(join(projectRoot, '.andromedacli'), { recursive: true, force: true });
  for (const f of ['permtest.txt', 'denytest.txt']) rmSync(join(projectRoot, f), { force: true });
}
const failed = results.filter(([, ok]) => !ok).length;
console.log(`${failed === 0 ? 'REAL MOD CONTRACT PASSED' : `${failed} FAILED`} in ${Math.round((Date.now() - started) / 1000)} s`);
process.exit(failed === 0 ? 0 : 1);
