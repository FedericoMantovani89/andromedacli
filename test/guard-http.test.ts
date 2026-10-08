import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { autoClose, bootServer, mod, req, ui, type Running } from './helpers';
import { gitSync, makeRepo, type TestRepo, removeDir, worktreePathFor } from './git-helpers';

// Real git and real processes: slow on a busy machine, so these tests get a longer budget.
vi.setConfig({ testTimeout: 60_000 });

const repos: TestRepo[] = [];
afterEach(() => { while (repos.length) removeDir(repos.pop()!.base); });
autoClose();

async function boot(config: Record<string, unknown> = {}): Promise<{ s: Running; t: TestRepo }> {
  const t = makeRepo({ remote: true });
  repos.push(t);
  const s = await bootServer({ projectRoot: t.repo, config: { git: { worktrees: true }, ...config } });
  return { s, t };
}
const spawn = async (s: Running, name: string): Promise<void> => {
  expect((await mod(s, 'shop-api', '/v1/tools/spawn_agent', 'POST', { name, profile: 'developer', goal: 'g' })).body.status).toBe('started');
};
const guard = (s: Running, slug: string, tool: string, input: unknown) => mod(s, slug, '/v1/guard', 'POST', { tool, input });
const logOf = (t: TestRepo): any[] => {
  const file = join(t.repo, '.andromedacli', 'state', 'guard.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

it('denies a dangerous command with the reason and the rule, and allows an ordinary one', async () => {
  const { s } = await boot();
  await spawn(s, 'first-job');
  const bad = await guard(s, 'first-job', 'Bash', { command: 'git push --force' });
  expect(bad.status).toBe(200);
  expect(bad.body).toMatchObject({ decision: 'deny', rule: 'git.force' });
  expect(bad.body.reason).toMatch(/force/i);
  expect((await guard(s, 'first-job', 'Bash', { command: 'git status' })).body).toEqual({ decision: 'allow' });
  expect((await guard(s, 'first-job', 'PowerShell', { command: 'cat .env' })).body).toMatchObject({ decision: 'deny', rule: 'secret.file' });
});
it('judges file tools against the caller\'s own worktree: each agent is denied the other\'s folder', async () => {
  const { s, t } = await boot();
  await spawn(s, 'first-job');
  await spawn(s, 'second-job');
  const a = join(worktreePathFor(t.repo, 'first-job'), 'src', 'a.ts');
  const b = join(worktreePathFor(t.repo, 'second-job'), 'src', 'b.ts');
  expect((await guard(s, 'first-job', 'Write', { file_path: a })).body.decision).toBe('allow');
  expect((await guard(s, 'first-job', 'Write', { file_path: b })).body).toMatchObject({ decision: 'deny', rule: 'path.outside-worktree' });
  expect((await guard(s, 'second-job', 'Write', { file_path: b })).body.decision).toBe('allow');
  expect((await guard(s, 'second-job', 'Edit', { file_path: a })).body).toMatchObject({ decision: 'deny' });
  expect((await guard(s, 'first-job', 'Write', { file_path: 'src/relative.ts' })).body.decision).toBe('allow');
  expect((await guard(s, 'first-job', 'Write', { file_path: join(t.repo, 'README.md') })).body.decision).toBe('deny'); // the main repo is not theirs
});
it('who is asking comes from the session token, never from the body', async () => {
  const { s, t } = await boot();
  await spawn(s, 'first-job');
  const other = join(worktreePathFor(t.repo, 'second-job'), 'x.ts');
  const r = await mod(s, 'first-job', '/v1/guard', 'POST', { tool: 'Write', input: { file_path: other }, slug: 'second-job', role: 'main', worktree: worktreePathFor(t.repo, 'second-job') });
  expect(r.body.decision).toBe('deny');
});
it('the main has fewer rules and works in the project folder', async () => {
  const { s, t } = await boot();
  expect((await guard(s, 'shop-api', 'Bash', { command: 'git commit -m x' })).body.decision).toBe('allow');
  expect((await guard(s, 'shop-api', 'Write', { file_path: join(t.repo, 'README.md') })).body.decision).toBe('allow');
  expect((await guard(s, 'shop-api', 'Bash', { command: 'git push --force' })).body).toMatchObject({ decision: 'deny', rule: 'git.force' });
  expect((await guard(s, 'shop-api', 'Bash', { command: 'git push origin main' })).body).toMatchObject({ decision: 'deny', rule: 'git.protected-ref' });
});
it('without worktrees an agent shares the project folder and is judged against it', async () => {
  const s = await bootServer();
  await spawn(s, 'first-job');
  expect((await guard(s, 'first-job', 'Bash', { command: 'git push' })).body.decision).toBe('deny');
  expect((await guard(s, 'first-job', 'Write', { file_path: 'src/a.ts' })).body.decision).toBe('allow');
});
it('an unknown tool is allowed; bad bodies are 400; tokens are required and only session tokens count', async () => {
  const { s } = await boot();
  await spawn(s, 'first-job');
  expect((await guard(s, 'first-job', 'SomethingNew', { x: 1 })).body).toEqual({ decision: 'allow' });
  expect((await guard(s, 'first-job', 'Bash', {})).body).toEqual({ decision: 'allow' }); // no command: nothing to judge
  expect((await mod(s, 'first-job', '/v1/guard', 'POST', {})).status).toBe(400);
  expect((await mod(s, 'first-job', '/v1/guard', 'POST', { tool: 5, input: {} })).status).toBe(400);
  expect((await mod(s, 'first-job', '/v1/guard', 'POST', { tool: 'Bash', input: 'git push' })).status).toBe(400);
  expect((await mod(s, 'first-job', '/v1/guard', 'POST', { tool: 'Bash', input: [] })).status).toBe(400);
  expect((await req(s, '/v1/guard', { method: 'POST', body: { tool: 'Bash', input: {} } })).status).toBe(401);
  expect((await req(s, '/v1/guard', { method: 'POST', token: s.token, body: { tool: 'Bash', input: {} } })).status).toBe(401);
  expect((await mod(s, 'first-job', '/v1/guard', 'GET')).status).toBe(404);
});
it('every deny is logged to .andromedacli/state/guard.jsonl; allows are not', async () => {
  const { s, t } = await boot();
  await spawn(s, 'first-job');
  await guard(s, 'first-job', 'Bash', { command: 'git status' });
  await guard(s, 'first-job', 'PowerShell', { command: 'fd -e ts' }); // the Windows shell tool counts too
  await guard(s, 'first-job', 'Bash', { command: 'git push --force' });
  const log = logOf(t);
  expect(log).toHaveLength(1);
  expect(log[0]).toMatchObject({ slug: 'first-job', role: 'agent', tool: 'Bash', rule: 'git.force', outcome: 'denied', mode: 'enforce', detail: 'git push --force' });
  expect(typeof log[0].ts).toBe('string');
});
it('shadow mode allows everything but logs what enforce would have denied', async () => {
  const { s, t } = await boot({ guard: { mode: 'shadow' } });
  await spawn(s, 'first-job');
  expect((await guard(s, 'first-job', 'Bash', { command: 'git push --force' })).body).toEqual({ decision: 'allow' });
  expect((await guard(s, 'first-job', 'Write', { file_path: 'D:\\other\\x' })).body).toEqual({ decision: 'allow' });
  const log = logOf(t);
  expect(log.map((l) => [l.rule, l.outcome, l.mode])).toEqual([['git.force', 'shadow-allowed', 'shadow'], ['path.outside-worktree', 'shadow-allowed', 'shadow']]);
});
it('the secret patterns come from the configuration', async () => {
  const { s } = await boot({ git: { worktrees: true, secretPatterns: ['*.token'] } });
  await spawn(s, 'first-job');
  expect((await guard(s, 'first-job', 'Bash', { command: 'cat a.token' })).body.decision).toBe('deny');
  expect((await guard(s, 'first-job', 'Bash', { command: 'cat .env' })).body.decision).toBe('allow');
});
it('the log keeps a long command short and never fails the answer when it cannot be written', async () => {
  const { s, t } = await boot();
  await spawn(s, 'first-job');
  await guard(s, 'first-job', 'Bash', { command: `git push --force ${'x'.repeat(5000)}` });
  expect(logOf(t)[0].detail.length).toBeLessThanOrEqual(400);
  expect((await ui(s, '/api/state')).status).toBe(200);
});

it('counts the optional helpers the shell commands use (counters only) and tells the agent which ones exist', async () => {
  const { s, t } = await boot();
  await spawn(s, 'first-job');
  await guard(s, 'first-job', 'Bash', { command: 'rg -n todo src | jq -r .name' });
  await guard(s, 'first-job', 'Bash', { command: 'rg again' });
  await guard(s, 'first-job', 'Bash', { command: 'git status' });
  await guard(s, 'first-job', 'PowerShell', { command: 'fd -e ts' }); // the Windows shell tool counts too
  await guard(s, 'first-job', 'Read', { file_path: 'rg' }); // not a shell command
  const state = (await ui(s, '/api/state')).body;
  expect(state.helperUse.counts).toEqual({ rg: 2, jq: 1, fd: 1 });
  expect(typeof state.helperUse.since).toBe('string');
  // The fake prerequisite runner answers for every tool, so the prompt of the agent lists the helpers.
  const prompt = readFileSync(join(t.repo, '.andromedacli', 'state', 'prompts', 'agent-first-job.md'), 'utf8');
  expect(prompt).toContain('Command-line helpers installed on this machine');
  expect(prompt).toContain('`rg` over `grep`');
});

it('a repository with no .gitignore: the main is told once to ask the user, the agent is told to keep its work clean; with one, neither', async () => {
  const { s, t } = await boot();
  const prompts = join(t.repo, '.andromedacli', 'state', 'prompts');
  const main = readFileSync(join(prompts, 'main-shop-api.md'), 'utf8');
  expect(main).toContain('No .gitignore was found in: the project folder.');
  expect(main).toContain('ask_user');
  await spawn(s, 'first-job');
  expect(readFileSync(join(prompts, 'agent-first-job.md'), 'utf8')).toContain('This repository has no .gitignore.');
  // the question is asked once per repository: a second main prompt of the same project does not repeat it
  const marker = JSON.parse(readFileSync(join(t.repo, '.andromedacli', 'state', 'gitignore-asked.json'), 'utf8'));
  expect(marker).toEqual(['']);
});
it('with a committed .gitignore the agent prompt has no such notice', async () => {
  const t = makeRepo({ remote: true });
  repos.push(t);
  writeFileSync(join(t.repo, '.gitignore'), 'node_modules\n');
  gitSync(t.repo, 'add', '-A');
  gitSync(t.repo, '-c', 'user.name=Tester', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'ignore');
  const s = await bootServer({ projectRoot: t.repo, config: { git: { worktrees: true } } });
  const prompts = join(t.repo, '.andromedacli', 'state', 'prompts');
  expect(readFileSync(join(prompts, 'main-shop-api.md'), 'utf8')).not.toContain('.gitignore');
  await spawn(s, 'first-job');
  expect(readFileSync(join(prompts, 'agent-first-job.md'), 'utf8')).not.toContain('no .gitignore');
});

it('an agent\'s goal is also saved as a file in its checkout, and the message that carries it names that file', async () => {
  const { s, t } = await boot();
  await spawn(s, 'first-job');
  const file = join(worktreePathFor(t.repo, 'first-job'), '.andromedacli', 'goal-first-job.md');
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(file, 'utf8')).toContain('\ng\n');
  const inbox = await mod(s, 'first-job', '/v1/inbox', 'GET');
  const text = (inbox.body.messages ?? []).map((m: { text: string }) => m.text).join('\n');
  expect(text).toContain('Your goal for this activity (written by the main session)');
  expect(text).toContain('goal-first-job.md');
});
