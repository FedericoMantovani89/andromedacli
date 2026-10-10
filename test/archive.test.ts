// Archiving agents that ended for good: the flag in the registry, what un-archives, what is persisted and restored, and the rules of
// the by-hand archive. Nothing is deleted: only a flag moves.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { archiveAgent, unarchiveAgent } from '../src/server/agents/archive';
import { AgentPersister } from '../src/server/agents/persist';
import { AgentRegistry } from '../src/server/agents/registry';
import { restoreAgents } from '../src/server/agents/restore';
import type { AgentPatch, AgentRecord } from '../src/server/project-store';
import { TicketStore } from '../src/server/tickets/store';
import { canArchive } from '../src/shared/archive';

let registry: AgentRegistry;
let tickets: TicketStore;
beforeEach(() => {
  registry = new AgentRegistry();
  tickets = new TicketStore(mkdtempSync(join(tmpdir(), 'archive-')));
});

const start = (slug: string): void => {
  registry.register({ slug, role: 'agent', profile: 'developer', goal: 'g' });
  registry.onSpawned(slug);
  registry.onModEvent(slug, { type: 'session.start', sessionId: `sess-${slug}` });
};

describe('automatic archive', () => {
  it('an agent whose session ended for good is archived when its process exits', () => {
    start('a');
    registry.markFinished('a');
    expect(registry.get('a')?.archived).toBeUndefined(); // not before the process is gone
    registry.onProcessExit('a');
    expect(registry.get('a')).toMatchObject({ state: 'finished', archived: true });
    expect(typeof registry.get('a')?.archivedAt).toBe('string');
  });
  it('an agent stopped on purpose (budget, loop, limit, replacement) is finished but not archived', () => {
    start('a');
    registry.markFinished('a', { stopped: true });
    registry.onProcessExit('a');
    expect(registry.get('a')).toMatchObject({ state: 'finished' });
    expect(registry.get('a')?.archived).toBeFalsy();
  });
  it('a crash (interrupted) and a running agent are never archived', () => {
    start('a'); start('b');
    registry.onProcessExit('a');
    expect(registry.get('a')).toMatchObject({ state: 'interrupted' });
    expect(registry.get('a')?.archived).toBeFalsy();
    expect(registry.get('b')?.archived).toBeFalsy();
  });
  it('an archive makes the registry notify, so it is persisted', () => {
    start('a');
    const seen: string[] = [];
    registry.on((s) => seen.push(s));
    registry.markFinished('a');
    registry.onProcessExit('a');
    expect(seen).toContain('a');
  });
});

describe('un-archive on new work', () => {
  const archived = (): void => { start('a'); registry.markFinished('a'); registry.onProcessExit('a'); };
  it('a revive (resume, recovery restart, send-back after a wake) clears the flag', () => {
    archived();
    registry.revive('a');
    expect(registry.get('a')?.archived).toBeFalsy();
    expect(registry.get('a')?.archivedAt).toBeUndefined();
  });
  it('a by-hand archive of an idle agent is cleared by its next turn', () => {
    start('a');
    registry.onModEvent('a', { type: 'turn.complete', sessionId: 's' });
    expect(registry.get('a')?.state).toBe('idle');
    expect(registry.setArchived('a', true)).toBe(true);
    registry.onModEvent('a', { type: 'turn.start', sessionId: 's' });
    expect(registry.get('a')?.archived).toBeFalsy();
  });
  it('a new registration of the same name starts not archived', () => {
    archived();
    registry.register({ slug: 'a', role: 'agent', profile: 'developer', goal: 'again' });
    expect(registry.get('a')?.archived).toBeFalsy();
  });
});

describe('canArchive (by hand)', () => {
  it('idle with a delivered or merged ticket, or finished without a waiting ticket', () => {
    expect(canArchive('idle', 'delivered')).toBe(true);
    expect(canArchive('idle', 'merged')).toBe(true);
    expect(canArchive('idle', 'released')).toBe(true);
    expect(canArchive('finished', undefined)).toBe(true);
    expect(canArchive('finished', 'merged')).toBe(true);
  });
  it('never a running, queued, dormant, interrupted or suspended agent, nor a stopped or waiting ticket', () => {
    for (const s of ['starting', 'working', 'waiting_user', 'queued', 'dormant', 'interrupted', 'studying', 'blocked', 'suspended'] as const) {
      expect(canArchive(s, 'merged')).toBe(false);
    }
    expect(canArchive('idle', undefined)).toBe(false);
    expect(canArchive('idle', 'in_progress')).toBe(false);
    for (const t of ['suspended_budget', 'suspended_limit', 'blocked', 'needs_user', 'recovering']) expect(canArchive('finished', t)).toBe(false);
  });
});

describe('archiveAgent / unarchiveAgent', () => {
  it('archives an idle agent with a delivered ticket and un-archives it again', () => {
    start('a');
    registry.onModEvent('a', { type: 'turn.complete', sessionId: 's' });
    tickets.setChecklist('a', []);
    tickets.move('a', 'delivered');
    expect(archiveAgent({ registry, ticketStatus: (s) => tickets.get(s)?.status }, 'a')).toEqual({ ok: true });
    expect(registry.get('a')?.archived).toBe(true);
    expect(unarchiveAgent({ registry }, 'a')).toEqual({ ok: true });
    expect(registry.get('a')?.archived).toBeFalsy();
  });
  it('refuses with a code: unknown name, the main, and an agent that is not finished-like', () => {
    registry.register({ slug: 'main', role: 'main', profile: 'main' });
    start('w');
    registry.onModEvent('w', { type: 'turn.start', sessionId: 's' });
    const d = { registry, ticketStatus: () => undefined };
    expect(archiveAgent(d, 'nobody')).toEqual({ ok: false, code: 'not_found' });
    expect(archiveAgent(d, 'main')).toEqual({ ok: false, code: 'agent.notArchivable' });
    expect(archiveAgent(d, 'w')).toEqual({ ok: false, code: 'agent.notArchivable' });
    expect(unarchiveAgent({ registry }, 'nobody')).toEqual({ ok: false, code: 'not_found' });
  });
});

describe('persistence', () => {
  it('the persister writes archived and archivedAt, and clears them when the agent is revived', () => {
    const patches: AgentPatch[] = [];
    const persister = new AgentPersister({ registry, updateAgent: (_s, p) => { patches.push(p); }, writeMainSession: () => undefined, mainSlug: 'main', minIntervalMs: 0 });
    registry.on((s) => persister.onChange(s));
    start('a');
    registry.markFinished('a');
    registry.onProcessExit('a');
    const last = patches[patches.length - 1]!;
    expect(last).toMatchObject({ lastState: 'finished', archived: true });
    expect(typeof last.archivedAt).toBe('string');
    registry.revive('a');
    const after = patches[patches.length - 1]!;
    expect(after).toHaveProperty('archived', undefined);
    expect(after).toHaveProperty('archivedAt', undefined);
  });
  const rec = (slug: string, o: Partial<AgentRecord> = {}): AgentRecord => ({ slug, profile: 'developer', createdAt: '2026-10-05T10:00:00Z', role: 'agent', sessionId: `sess-${slug}`, lastState: 'idle', ...o });
  const run = (records: AgentRecord[]) => restoreAgents({ records, registry, tickets, worktrees: false, cleanStop: true, worktreeExists: () => true, abandonReview: () => false });
  it('a restored agent that was archived stays archived; one that was not stays visible', () => {
    tickets.setChecklist('kept', []); tickets.move('kept', 'delivered');
    run([rec('kept', { archived: true, archivedAt: '2026-10-09T08:00:00Z' }), rec('other')]);
    expect(registry.get('kept')).toMatchObject({ state: 'dormant', archived: true, archivedAt: '2026-10-09T08:00:00Z' });
    expect(registry.get('other')?.archived).toBeFalsy();
  });
  it('an agent whose ticket waits for a decision is restored finished and visible even if a stale flag is on its record', () => {
    tickets.setChecklist('s', []); tickets.move('s', 'suspended_budget');
    run([rec('s', { archived: true })]);
    expect(registry.get('s')).toMatchObject({ state: 'finished' });
    expect(registry.get('s')?.archived).toBeFalsy();
  });
  it('waking a restored archived agent un-archives it', () => {
    tickets.setChecklist('k', []); tickets.move('k', 'delivered');
    run([rec('k', { archived: true })]);
    registry.revive('k');
    expect(registry.get('k')?.archived).toBeFalsy();
  });
});
