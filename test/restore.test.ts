import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/server/agents/registry';
import { renderRestartNotice, restoreAgents } from '../src/server/agents/restore';
import type { AgentRecord } from '../src/server/plan-store';
import { TicketStore } from '../src/server/tickets/store';

let root: string;
let tickets: TicketStore;
let registry: AgentRegistry;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'restore-')); tickets = new TicketStore(root); registry = new AgentRegistry(); });

const wt = (slug: string): string => { const p = join(root, 'wt', slug); mkdirSync(p, { recursive: true }); return p; };
const rec = (slug: string, o: Partial<AgentRecord> = {}): AgentRecord => ({
  slug, profile: 'backend', createdAt: '2026-10-05T10:00:00Z', role: 'agent', sessionId: `sess-${slug}`,
  worktree: wt(slug), branch: `agent/p/${slug}`, lastState: 'idle', ...o,
});
const run = (records: AgentRecord[], o: { cleanStop?: boolean; worktrees?: boolean; abandon?: (r: string) => boolean } = {}) => restoreAgents({
  records, registry, tickets, worktrees: o.worktrees ?? true, cleanStop: o.cleanStop ?? true,
  worktreeExists: (p) => p.startsWith(root) && !p.includes('gone'), abandonReview: o.abandon ?? (() => false),
});

describe('restoreAgents', () => {
  it('a clean restart makes every agent dormant, even one that was mid-turn, and starts nothing', () => {
    for (const s of ['a', 'b', 'c']) tickets.setGoal(s, `goal ${s}`);
    const r = run([rec('a'), rec('b', { lastState: 'working' }), rec('c')]);
    expect(r.dormant.map((d) => d.slug)).toEqual(['a', 'b', 'c']);
    expect(r.interrupted).toEqual([]);
    expect(registry.get('b')).toMatchObject({ state: 'dormant', sessionId: 'sess-b', goal: 'goal b' });
    expect(registry.isActive('b')).toBe(false);
  });
  it('a crash marks only the agent that was working or starting as interrupted', () => {
    const r = run([rec('a', { lastState: 'working' }), rec('b', { lastState: 'idle' }), rec('c', { lastState: 'starting' })], { cleanStop: false });
    expect(r.interrupted.map((i) => [i.slug, i.reason])).toEqual([['a', 'turn_lost'], ['c', 'turn_lost']]);
    expect(r.dormant.map((d) => d.slug)).toEqual(['b']);
    expect(registry.get('a')?.state).toBe('interrupted');
  });
  it('a missing worktree or session is interrupted, never dormant; with worktrees off the worktree is not needed', () => {
    const r = run([rec('a', { worktree: join(root, 'gone') }), rec('b', { sessionId: undefined }), rec('c', { worktree: undefined, branch: undefined })]);
    expect(r.interrupted.map((i) => [i.slug, i.reason])).toEqual([['a', 'no_worktree'], ['b', 'no_session'], ['c', 'no_worktree']]);
    const off = run([rec('d', { worktree: undefined, branch: undefined })], { worktrees: false });
    expect(off.dormant.map((d) => d.slug)).toEqual(['d']);
  });
  it('reviewers, recoveries and merged tickets are not restored', () => {
    tickets.setGoal('m', 'x'); tickets.move('m', 'delivered'); tickets.move('m', 'in_review'); tickets.move('m', 'approved'); tickets.move('m', 'merged');
    const r = run([rec('rev', { role: 'reviewer' }), rec('rec', { profile: 'recovery', role: undefined }), rec('m')]);
    expect(r.dormant).toEqual([]);
    expect(registry.list()).toEqual([]);
  });
  it('stopped tickets are registered finished (they restart through their own flows)', () => {
    tickets.setGoal('s', 'x'); tickets.move('s', 'suspended_limit');
    const r = run([rec('s')]);
    expect(r.stopped.map((x) => x.slug)).toEqual(['s']);
    expect(registry.get('s')?.state).toBe('finished');
  });
  it('an orphan review is repaired through abandonReview and a recovering ticket goes back to its stop status', () => {
    tickets.setGoal('r', 'x'); tickets.move('r', 'delivered'); tickets.move('r', 'in_review', { reviewer: 'review-r' });
    tickets.setGoal('q', 'x'); tickets.move('q', 'suspended_budget'); tickets.move('q', 'recovering');
    const asked: string[] = [];
    const r = run([rec('r'), rec('q')], { abandon: (who) => { asked.push(who); return true; } });
    expect(asked).toEqual(['review-r']);
    expect(tickets.get('q')?.status).toBe('suspended_budget');
    expect(r.repaired.sort()).toEqual(['q', 'r']);
    expect(registry.get('q')?.state).toBe('finished');
  });
});

describe('renderRestartNotice', () => {
  it('lists the agents by group and is silent when there is nothing to say', () => {
    expect(renderRestartNotice({ dormant: [], interrupted: [], stopped: [], repaired: [] })).toBeUndefined();
    const text = renderRestartNotice({ dormant: [{ slug: 'a', ticket: 'in_progress' }], interrupted: [{ slug: 'b', reason: 'turn_lost' }], stopped: [], repaired: ['c'] })!;
    expect(text).toContain('- a (ticket: in_progress)');
    expect(text).toContain('- b: the turn in progress was lost');
    expect(text).toContain('resume_agent');
    expect(text).not.toMatch(/\{\w+\}/);
  });
});
