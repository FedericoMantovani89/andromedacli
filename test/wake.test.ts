import { beforeEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/server/agents/registry';
import { Inbox } from '../src/server/agents/inbox';
import { ResumeService } from '../src/server/agents/resume';
import { WakeService, type WakeReason } from '../src/server/agents/wake';

let registry: AgentRegistry;
let launched: { slug: string; sessionId: string; reason: WakeReason }[];
let quotaHigh: boolean;
let worktree: boolean;
let launchResult: { ok: true } | { ok: false; code: string };
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

beforeEach(() => {
  registry = new AgentRegistry();
  launched = []; quotaHigh = false; worktree = true; launchResult = { ok: true };
  registry.registerDormant({ slug: 'a', role: 'agent', profile: 'developer', sessionId: 'sess-a' });
});
const make = () => new WakeService({
  registry,
  launch: async (slug, sessionId, reason) => { launched.push({ slug, sessionId, reason }); if (launchResult.ok) registry.revive(slug); return launchResult; },
  hasWorktree: () => worktree, quotaHigh: () => quotaHigh, changed: () => undefined,
});

describe('WakeService', () => {
  it('the user wakes a dormant agent with its stored session', async () => {
    expect(await make().wake('a', 'user')).toEqual({ ok: true, status: 'queued' }); // revive() leaves it waiting for its slot
    expect(launched).toEqual([{ slug: 'a', sessionId: 'sess-a', reason: 'user' }]);
  });
  it('refuses what is not dormant, has no session or worktree, or while the quota is frozen', async () => {
    const w = make();
    expect(await w.wake('nobody', 'user')).toEqual({ ok: false, code: 'agent.notDormant' });
    registry.registerRestored({ slug: 'i', role: 'agent', profile: 'developer', sessionId: 'sess-i', state: 'interrupted' });
    expect(await w.wake('i', 'work')).toEqual({ ok: false, code: 'agent.notDormant' }); // work never restarts an interrupted agent
    registry.registerDormant({ slug: 'n', role: 'agent', profile: 'developer' });
    expect(await w.wake('n', 'user')).toEqual({ ok: false, code: 'agent.noSession' });
    worktree = false;
    expect(await w.wake('a', 'user')).toEqual({ ok: false, code: 'agent.noWorktree' });
    worktree = true; quotaHigh = true;
    expect(await w.wake('a', 'user')).toEqual({ ok: false, code: 'agent.quotaHigh' });
    expect(launched).toEqual([]);
  });
  it('the main may wake an interrupted agent', async () => {
    registry.registerRestored({ slug: 'i', role: 'agent', profile: 'developer', sessionId: 'sess-i', state: 'interrupted' });
    expect((await make().wake('i', 'main')).ok).toBe(true);
  });
  it('a launch that fails is reported as wakeFailed', async () => {
    launchResult = { ok: false, code: 'agent.spawnFailed' };
    expect(await make().wake('a', 'user')).toEqual({ ok: false, code: 'agent.wakeFailed' });
  });
  it('work arriving in the inbox wakes the dormant target once; the message stays queued', async () => {
    const w = make();
    const inbox = new Inbox();
    inbox.onPush((s) => w.onWork(s));
    inbox.push('a', 'merge conflict');
    inbox.push('a', 'second');
    await flush();
    expect(launched).toHaveLength(1);
    expect(launched[0]!.reason).toBe('work');
    expect(inbox.pending('a')).toHaveLength(2);
    inbox.push('main', 'not dormant');
    await flush();
    expect(launched).toHaveLength(1);
  });
});

describe('resume_agent wakes dormant agents (ResumeService)', () => {
  const resumer = (woke: string[]) => new ResumeService({
    tickets: { restart: () => { throw new Error('must not touch tickets'); } } as never, registry,
    config: () => ({ halvePercent: 70, freezePercent: 85, stopPercent: 95, staggerSeconds: 0, staggerGroup: 3 }),
    quotaWorst: () => undefined, clock: { now: () => 0, setTimeout: () => 0, clearTimeout: () => undefined },
    launch: async () => ({ ok: true }), suspendedTickets: () => [], hasWorktree: () => true,
    wakeable: (s) => registry.get(s)?.state === 'dormant' || registry.get(s)?.state === 'interrupted',
    wake: async (s) => { woke.push(s); return { ok: true }; },
    tellMain: () => undefined, changed: () => undefined,
  });
  it('accepts a dormant name without changing any ticket and still refuses unknown names', async () => {
    const woke: string[] = [];
    const r = resumer(woke).resume(['a']);
    await flush();
    expect(r).toMatchObject({ status: 'ok', started: ['a'] });
    expect(woke).toEqual(['a']);
    expect(resumer([]).resume(['zzz'])).toMatchObject({ status: 'refused', code: 'not_suspended' });
  });
});
