import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canMove, nextStatuses, TICKET_STATUSES, type TicketStatus } from '../src/server/tickets/flow';
import { validateChecklist, type Step } from '../src/server/tickets/checklist';
import { TicketStore } from '../src/server/tickets/store';

const LEGAL: Record<TicketStatus, TicketStatus[]> = {
  in_progress: ['delivered', 'needs_user'],
  delivered: ['in_review', 'needs_user'],
  in_review: ['approved', 'changes_requested', 'needs_user', 'delivered'],
  changes_requested: ['in_progress', 'needs_user'],
  approved: ['merged', 'conflict', 'changes_requested', 'needs_user'],
  conflict: ['in_progress', 'needs_user'],
  merged: ['released'],
  needs_user: ['in_progress', 'delivered', 'approved', 'merged'],
  released: [],
};

describe('ticket flow', () => {
  it('knows every status', () => {
    expect([...TICKET_STATUSES].sort()).toEqual(Object.keys(LEGAL).sort());
  });
  it.each(TICKET_STATUSES.flatMap((from) => TICKET_STATUSES.map((to) => [from, to] as const)))('%s -> %s', (from, to) => {
    expect(canMove(from, to)).toBe(LEGAL[from].includes(to));
  });
  it('lists the next statuses', () => {
    expect(nextStatuses('in_review')).toEqual(['approved', 'changes_requested', 'needs_user', 'delivered']);
    expect(nextStatuses('released')).toEqual([]);
  });
  it('an unknown status cannot move anywhere', () => {
    expect(canMove('nonsense' as TicketStatus, 'delivered')).toBe(false);
    expect(nextStatuses('nonsense' as TicketStatus)).toEqual([]);
  });
});

let root: string;
let store: TicketStore;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'flow-')); store = new TicketStore(root); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const steps = (): Step[] => {
  const r = validateChecklist(['Study', 'Tests first', 'Implement a', 'Implement b', 'Validation', 'Update docs']);
  if (!r.ok) throw new Error(r.code);
  return r.steps.map((s) => ({ ...s, done: true, sha: `sha${s.n}` }));
};
const ticketAt = (status: TicketStatus): void => {
  store.setChecklist('a', steps());
  const path: Record<string, TicketStatus[]> = {
    in_progress: [], delivered: ['delivered'], in_review: ['delivered', 'in_review'], changes_requested: ['delivered', 'in_review', 'changes_requested'],
    approved: ['delivered', 'in_review', 'approved'], conflict: ['delivered', 'in_review', 'approved', 'conflict'],
    merged: ['delivered', 'in_review', 'approved', 'merged'], needs_user: ['delivered', 'needs_user'], released: ['delivered', 'in_review', 'approved', 'merged', 'released'],
  };
  for (const s of path[status]!) store.move('a', s);
};

describe('TicketStore pipeline', () => {
  it('move follows the flow and refuses everything else', () => {
    store.setChecklist('a', steps());
    expect(() => store.move('a', 'merged')).toThrow('ticket.badTransition');
    expect(() => store.move('a', 'in_progress')).toThrow('ticket.badTransition');
    store.move('a', 'delivered', { deliveredSha: 'abc123' });
    expect(store.get('a')).toMatchObject({ status: 'delivered', deliveredSha: 'abc123' });
    expect(() => store.move('ghost', 'delivered')).toThrow('ticket.missing');
  });
  it('the whole happy path works and each step is persisted', () => {
    ticketAt('in_progress');
    for (const s of ['delivered', 'in_review', 'approved', 'merged', 'released'] as const) {
      store.move('a', s, s === 'merged' ? { mergedSha: 'def456' } : undefined);
      expect(new TicketStore(root).get('a')?.status).toBe(s);
    }
    expect(store.get('a')?.mergedSha).toBe('def456');
    expect(() => store.move('a', 'in_progress')).toThrow('ticket.badTransition');
  });
  it('a Phase 3 ticket file (no pipeline fields) reads with defaults', () => {
    const dir = join(root, '.console', 'state', 'tickets');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'old.json'), JSON.stringify({ slug: 'old', steps: [], status: 'delivered', blocked: false, updatedAt: 'x' }));
    expect(store.get('old')).toMatchObject({ status: 'delivered', round: 0, verdicts: [] });
  });
  it('records the goal, the test result and the reviewer', () => {
    store.setChecklist('a', steps());
    store.setGoal('a', '  Add multiply  ');
    store.setTests('a', { ok: false, command: 'npm test', tail: 'boom', sha: 'abc', at: '2026-10-05T10:00:00Z' });
    store.move('a', 'delivered');
    store.move('a', 'in_review', { reviewer: 'review-a' });
    expect(store.get('a')).toMatchObject({ goal: 'Add multiply', tests: { ok: false, sha: 'abc' }, reviewer: 'review-a' });
  });
  it('a goal is cut to a sane size', () => {
    store.setGoal('a', 'x'.repeat(10_000));
    expect(store.get('a')!.goal!.length).toBeLessThanOrEqual(4000);
  });
  it('addVerdict numbers the review rounds from 1 and keeps the notes', () => {
    ticketAt('in_review');
    store.addVerdict('a', { pass: false, reviewer: 'review-a', notes: [{ severity: 'high', where: 'src/a.ts:4', text: 'null not handled' }] });
    expect(store.get('a')!.verdicts).toEqual([{ round: 1, pass: false, reviewer: 'review-a', notes: [{ severity: 'high', where: 'src/a.ts:4', text: 'null not handled' }], at: expect.any(String) }]);
    store.move('a', 'changes_requested');
    store.reopen('a');
    store.setChecklist('a', store.get('a')!.steps.map((s) => ({ ...s, done: true })));
    store.move('a', 'delivered');
    store.move('a', 'in_review');
    store.addVerdict('a', { pass: true, reviewer: 'review-a', notes: [] });
    expect(store.get('a')!.verdicts.map((v) => [v.round, v.pass])).toEqual([[1, false], [2, true]]);
  });
  it('reopen appends the three round steps, keeps the done ones, and goes back to in_progress', () => {
    ticketAt('changes_requested');
    const before = store.get('a')!.steps;
    store.reopen('a');
    const t = store.get('a')!;
    expect(t.status).toBe('in_progress');
    expect(t.round).toBe(1);
    expect(t.steps.slice(0, before.length)).toEqual(before);
    expect(t.steps.slice(before.length).map((s) => [s.n, s.title, s.done])).toEqual([
      [7, 'Review fixes (round 1)', false], [8, 'Validation (round 1)', false], [9, 'Update documentation (round 1)', false],
    ]);
    // the appended steps satisfy the same skeleton the agent is held to
    expect(validateChecklist(t.steps.map((s) => s.title), t.steps).ok).toBe(true);
  });
  it('reopen works from conflict and needs_user too, and is refused from anywhere else', () => {
    ticketAt('conflict');
    store.reopen('a');
    expect(store.get('a')!.status).toBe('in_progress');
    for (const s of ['delivered', 'in_review', 'approved', 'merged'] as const) { if (s === 'delivered') store.move('a', s); else store.move('a', s); }
    expect(() => store.reopen('a')).toThrow('ticket.badTransition');
  });
  it('a second reopen numbers its steps by round', () => {
    ticketAt('changes_requested');
    store.reopen('a');
    store.setChecklist('a', store.get('a')!.steps.map((s) => ({ ...s, done: true })));
    store.move('a', 'delivered'); store.move('a', 'in_review'); store.move('a', 'changes_requested');
    store.reopen('a');
    expect(store.get('a')!.steps.slice(-3).map((s) => s.title)).toEqual(['Review fixes (round 2)', 'Validation (round 2)', 'Update documentation (round 2)']);
    expect(store.get('a')!.round).toBe(2);
  });
  it('the old setStatus is gone: delivery goes through move', () => {
    expect((store as unknown as Record<string, unknown>).setStatus).toBeUndefined();
  });
});
