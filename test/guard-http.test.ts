import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { autoClose, bootServer, mod, req, ui, type Running } from './helpers';
import { makeRepo, type TestRepo, removeDir } from './git-helpers';
import { worktreePathFor } from '../src/server/git/worktree';

// Real git and real processes: slow on a busy machine, so these tests get a longer budget.
vi.setConfig({ testTimeout: 60_000 });

const repos: TestRepo[] = [];
afterEach(() => { while (repos.length) removeDir(repos.pop()!.base); });
autoClose();

async function boot(config: Record<string, unknown> = {}): Promise<{ s: Running; t: TestRepo }> {
  const t = makeRepo({ remote: true });
  repos.push(t);
  const s = await bootServer({ planRoot: t.repo, config: { git: { worktrees: true }, ...config } });
  return { s, t };
}
const spawn = async (s: Running, name: string): Promise<void> => {
  expect((await mod(s, 'shop-api', '/v1/tools/spawn_agent', 'POST', { name, profile: 'backend', goal: 'g' })).body.status).toBe('started');
};
const guard = (s: Running, slug: string, tool: string, input: unknown) => mod(s, slug, '/v1/guard', 'POST', { tool, input });
const logOf = (t: TestRepo): any[] => {
  const file = join(t.repo, '.console', 'state', 'guard.jsonl');
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
it('the main has fewer rules and works in the plan folder', async () => {
  const { s, t } = await boot();
  expect((await guard(s, 'shop-api', 'Bash', { command: 'git commit -m x' })).body.decision).toBe('allow');
  expect((await guard(s, 'shop-api', 'Write', { file_path: join(t.repo, 'README.md') })).body.decision).toBe('allow');
  expect((await guard(s, 'shop-api', 'Bash', { command: 'git push --force' })).body).toMatchObject({ decision: 'deny', rule: 'git.force' });
  expect((await guard(s, 'shop-api', 'Bash', { command: 'git push origin main' })).body).toMatchObject({ decision: 'deny', rule: 'git.protected-ref' });
});
it('without worktrees an agent shares the plan folder and is judged against it', async () => {
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
it('every deny is logged to .console/state/guard.jsonl; allows are not', async () => {
  const { s, t } = await boot();
  await spawn(s, 'first-job');
  await guard(s, 'first-job', 'Bash', { command: 'git status' });
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
