// A guard question and a console tool call are signs of life of the session (SPEC 17.1): a long turn without mod events is not a
// silence. The /v1 layer tells the server about them through `activity`.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { handleV1, type V1Context } from '../src/server/v1';
import { SessionTokens } from '../src/server/security';
import { Inbox } from '../src/server/agents/inbox';
import { AgentRegistry } from '../src/server/agents/registry';
import { QuestionQueue } from '../src/server/questions/queue';
import { LoopDetector } from '../src/server/budget/loop-detector';

const servers: http.Server[] = [];
afterEach(async () => { while (servers.length) await new Promise((r) => servers.pop()!.close(r)); });

async function boot(activity: (slug: string) => void) {
  const tokens = new SessionTokens();
  const token = tokens.issue('job-a');
  const registry = new AgentRegistry();
  registry.register({ slug: 'job-a', role: 'agent', profile: 'developer' });
  const ctx: V1Context = {
    tokens, inbox: new Inbox(), registry, questions: new QuestionQueue(),
    handleModEvent: () => {}, tools: { list_agents: async () => ({ agents: [] }) },
    guard: () => ({ decision: 'allow' }), activity,
  };
  const server = http.createServer((req, res) => { void handleV1(ctx, req, res, new URL(req.url ?? '/', 'http://127.0.0.1')); });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const port = (server.address() as AddressInfo).port;
  const post = async (path: string, body: unknown): Promise<number> => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.status;
  };
  return { post };
}

it('a guard question and a console tool call count as activity of the calling session', async () => {
  const seen: string[] = [];
  const { post } = await boot((slug) => seen.push(slug));
  expect(await post('/v1/guard', { tool: 'Bash', input: { command: 'npm test' } })).toBe(200);
  expect(await post('/v1/tools/list_agents', {})).toBe(200);
  expect(seen).toEqual(['job-a', 'job-a']);
});

it('wired to the loop detector, a guard question during a long turn ends the silence', async () => {
  let now = 0;
  const detector = new LoopDetector(() => ({ sameCall: 5, sameError: 3, compactions: 2, stepMinutes: 30, silenceMinutes: 5 }), () => now);
  detector.onModEvent('job-a'); // the turn started
  const { post } = await boot((slug) => detector.onModEvent(slug));
  now = 4 * 60_000;
  expect(await post('/v1/guard', { tool: 'Bash', input: { command: 'npm test' } })).toBe(200); // a tool call 4 minutes in
  now = 6 * 60_000; // 6 minutes after the turn started, 2 after the tool call
  expect(detector.tick(['job-a'])).toEqual([]);
});
