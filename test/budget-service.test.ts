import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BudgetService, type BudgetDeps } from '../src/server/budget/service';
import { Ledger } from '../src/server/budget/ledger';
import { TranscriptReader } from '../src/server/budget/transcript';
import { TicketStore } from '../src/server/tickets/store';
import { DEFAULT_CONFIG } from '../src/server/config';
import { budgetAnswerHandler } from '../src/server/budget/answers';

function rig(limit = 1000, o: { live?: () => boolean; wipFails?: boolean; wipRejects?: boolean; wipSlow?: boolean; restrictThrows?: boolean; ledgerFails?: boolean; ledgerDir?: string; root?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'h-bud-'));
  const file = join(dir, 't.jsonl');
  writeFileSync(file, '');
  const tickets = new TicketStore(dir);
  tickets.setChecklist('a', [{ n: 1, title: 'x', done: false }] as never);
  const calls: string[] = [];
  const mains: string[] = [];
  let now = 1_000_000;
  const faults = { config: false, transcript: false };
  const ledger = new Ledger(o.ledgerDir ?? join(dir, 'ledger'));
  if (o.ledgerFails) ledger.append = () => { throw new Error('disk full'); };
  const d: BudgetDeps = {
    tickets, ledger, reader: new TranscriptReader(), project: 'p', root: o.root ?? dir,
    config: () => { if (faults.config) throw new Error('config boom'); return DEFAULT_CONFIG.budget; }, now: () => now,
    transcriptOf: () => { if (faults.transcript) throw new Error('transcript boom'); return file; }, isLive: () => (o.live ? o.live() : true),
    wipCommit: async (_s, r) => {
      calls.push(`wip:${r}`);
      if (o.wipSlow) await new Promise((res) => setTimeout(res, 30));
      if (o.wipRejects) throw new Error('wip boom');
      return o.wipFails ? { ok: false, detail: 'index locked' } : { ok: true }; },
    tellAgent: (_s, t) => calls.push(`agent:${t.slice(0, 12)}`),
    tellMain: (t) => { mains.push(t); calls.push(`main:${t.slice(0, 12)}`); },
    restrict: (_s, why) => { if (o.restrictThrows) throw new Error('restrict boom'); calls.push(`restrict:${why}`); }, stop: async () => { calls.push('stop'); },
    askUser: (q) => calls.push(`ask:${q.options.join('/')}`), changed: () => calls.push('changed'),
  };
  const svc = new BudgetService(d);
  svc.begin('a', limit);
  let n = 0;
  const write = (output: number) => appendFileSync(file, `${JSON.stringify({ type: 'assistant', message: { id: `m${++n}`, usage: { input_tokens: 0, output_tokens: output }, content: [] } })}\n`);
  const turn = async (output: number) => {
    write(output);
    await svc.onTurnComplete('a', { sessionId: 's', turn: n });
  };
  return { svc, d, tickets, calls, mains, turn, write, nth: () => n, advance: (ms: number) => { now += ms; }, file, faults, dir };
}

describe('BudgetService', () => {
  it('a resumed session is primed: what its transcript already holds is not counted again after a console restart', async () => {
    const r = rig();
    r.write(600); // an earlier run: counted in the ledger by a console that has since stopped
    await r.svc.onTurnComplete('a', { sessionId: 's', turn: 1 });
    expect(r.svc.usage('a')).toEqual({ used: 600, limit: 1000, step: 'ok' });
    const restarted = new TranscriptReader(); // the new console knows nothing of the file
    r.d.reader = restarted;
    r.svc.primeTranscript('a'); // spawn does this just before `claude --resume`
    r.write(100); // the resumed session adds one message
    await r.svc.onTurnComplete('a', { sessionId: 's', turn: 2 });
    expect(r.svc.usage('a')).toEqual({ used: 700, limit: 1000, step: 'ok' }); // 600 + 100, not 600 + 600 + 100
  });
  it('stays quiet under 80% and reports usage', async () => {
    const r = rig();
    await r.turn(700);
    expect(r.svc.usage('a')).toEqual({ used: 700, limit: 1000, step: 'ok' });
    expect(r.calls.filter((c) => c.startsWith('wip'))).toEqual([]);
  });

  it('alerts once at 80%: WIP commit, message to the agent and to the main', async () => {
    const r = rig();
    await r.turn(850);
    await r.turn(10);
    expect(r.calls.filter((c) => c.startsWith('wip'))).toHaveLength(1);
    expect(r.calls.filter((c) => c.startsWith('agent'))).toHaveLength(1);
    expect(r.calls.filter((c) => c.startsWith('main'))).toHaveLength(1);
    expect(r.calls.filter((c) => c.startsWith('restrict') || c === 'stop')).toEqual([]);
    expect(r.svc.usage('a')?.step).toBe('alert');
  });

  it('limits at 100%, and stops after the grace with the ticket suspended and a queue item', async () => {
    const r = rig();
    await r.turn(1000);
    expect(r.svc.usage('a')?.step).toBe('limit');
    expect(r.calls).toContain('restrict:budget');
    r.advance(5 * 60_000 + 1);
    await r.turn(1);
    expect(r.svc.usage('a')?.step).toBe('stopped');
    expect(r.tickets.get('a')).toMatchObject({ status: 'suspended_budget', stopCause: 'budget' });
    expect(r.calls).toContain('stop');
    expect(r.calls).toContain('ask:raise/close/recover');
  });

  it('tick() stops a quiet agent in limit after the grace, without a turn', async () => {
    const r = rig();
    await r.turn(1000);
    await r.svc.tick();
    expect(r.svc.usage('a')?.step).toBe('limit');
    r.advance(5 * 60_000 + 1);
    await r.svc.tick();
    expect(r.svc.usage('a')?.step).toBe('stopped');
    expect(r.calls.filter((c) => c === 'stop')).toHaveLength(1);
  });

  it('stops at once at 110%', async () => {
    const r = rig();
    await r.turn(1100);
    expect(r.svc.usage('a')?.step).toBe('stopped');
  });

  it('applies each missing action once when one turn crosses every threshold', async () => {
    const r = rig();
    await r.turn(2000);
    expect(r.calls.filter((c) => c.startsWith('wip:'))).toHaveLength(2); // the alert one and the final one, not four
    expect(r.calls.filter((c) => c === 'restrict:budget')).toHaveLength(1);
    expect(r.calls.filter((c) => c === 'stop')).toHaveLength(1);
    await r.turn(5);
    expect(r.calls.filter((c) => c === 'stop')).toHaveLength(1);
  });

  it('is n/a without a limit, and does not advance on an unreadable transcript', async () => {
    const r = rig();
    expect(r.svc.usage('nobody')).toBeUndefined();
    rmSync(r.file);
    await r.svc.onTurnComplete('a', { sessionId: 's', turn: 9 });
    expect(r.svc.usage('a')).toBeUndefined(); // nothing written, nothing invented: n/a, never zero
    expect(r.tickets.get('a')?.budget).toEqual({ limit: 1000, step: 'ok' });
    expect(r.calls.filter((c) => !c.startsWith('main:'))).toEqual([]);
  });

  it('usage is n/a until the first readable turn, then appears', async () => {
    const r = rig();
    expect(r.svc.usage('a')).toBeUndefined();
    await r.turn(10);
    expect(r.svc.usage('a')).toEqual({ used: 10, limit: 1000, step: 'ok' });
  });

  it('a missing transcript is told to the main once per agent', async () => {
    const r = rig();
    rmSync(r.file);
    await r.svc.onTurnComplete('a', { sessionId: 's', turn: 1 });
    await r.svc.onTurnComplete('a', { sessionId: 's', turn: 2 });
    const told = r.mains.filter((m) => m.startsWith('budget is not enforced for a: no transcript found under'));
    expect(told).toHaveLength(1);
    expect(told[0]).toContain(r.file);
  });

  it('the same agent name in another project folder does not share the budget (a stopped one does not stop the other)', async () => {
    const ledgerDir = mkdtempSync(join(tmpdir(), 'h-bud-led-'));
    const one = rig(1000, { ledgerDir, root: 'C:/w/one' });
    await one.turn(1100);
    expect(one.svc.usage('a')?.step).toBe('stopped');
    const two = rig(1000, { ledgerDir, root: 'C:/w/two' });
    await two.turn(10);
    expect(two.svc.usage('a')).toEqual({ used: 10, limit: 1000, step: 'ok' });
    expect(two.calls.filter((c) => c === 'stop' || c.startsWith('ask:'))).toEqual([]);
  });

  it('a ticket that is not in_progress is left alone: a delivered one is not stopped after its grace', async () => {
    const r = rig();
    await r.turn(1000);
    expect(r.svc.usage('a')?.step).toBe('limit');
    r.tickets.move('a', 'delivered');
    r.advance(5 * 60_000 + 1);
    await r.svc.tick();
    await r.turn(5); // usage is still recorded
    expect(r.svc.usage('a')).toEqual({ used: 1005, limit: 1000, step: 'limit' });
    expect(r.calls.filter((c) => c === 'stop' || c.startsWith('ask:'))).toEqual([]);
    expect(r.tickets.get('a')?.status).toBe('delivered');
  });

  it('a ticket left at limit by an earlier run, now delivered, is ignored by tick', async () => {
    const r = rig();
    await r.turn(1000);
    const fresh = new BudgetService(r.d); // a restarted console: nothing in memory, the step on disk
    r.tickets.move('a', 'delivered');
    r.advance(60 * 60_000);
    await fresh.tick();
    expect(r.tickets.get('a')?.budget?.step).toBe('limit');
    expect(r.calls.filter((c) => c === 'stop' || c.startsWith('ask:'))).toEqual([]);
  });

  it('raise after a stop at 160% gives max(limit, used) * 1.5 and never stops twice', async () => {
    const r = rig();
    await r.turn(1600);
    expect(r.svc.usage('a')?.step).toBe('stopped');
    // the replacement agent keeps the ticket name here: only the budget handling is under test
    const recovery = {
      start: async () => ({ ok: false as const, code: 'not_stopped' }),
      restart: async (slug: string, o: { limit: number }) => { r.svc.restart(slug, o.limit); return { ok: true as const, agent: slug }; },
    };
    const answer = budgetAnswerHandler({ budget: r.svc, tickets: r.tickets, recovery, tellMain: () => undefined, changed: () => undefined });
    await answer('raise', { ticket: 'a' });
    expect(r.svc.usage('a')?.limit).toBe(2400);
    r.advance(10 * 60_000);
    await r.svc.tick();
    await r.svc.tick();
    expect(r.calls.filter((c) => c === 'stop')).toHaveLength(1);
    expect(r.calls.filter((c) => c.startsWith('ask:'))).toHaveLength(1);
  });

  it('a failing turn or tick is told to the main once per agent, and never rejects', async () => {
    const r = rig();
    r.faults.transcript = true;
    // A failed read resolves with no events (since Task 13 the loop detector consumes them), never a rejection.
    await expect(r.svc.onTurnComplete('a', { sessionId: 's', turn: 1 })).resolves.toEqual([]);
    await expect(r.svc.onTurnComplete('a', { sessionId: 's', turn: 2 })).resolves.toEqual([]);
    expect(r.mains.filter((m) => m === 'budget tracking failed for a: transcript boom')).toHaveLength(1);
    const t = rig();
    await t.turn(1000);
    t.faults.config = true;
    await expect(t.svc.tick()).resolves.toBeUndefined();
    await expect(t.svc.tick()).resolves.toBeUndefined();
    expect(t.mains.filter((m) => m === 'budget tracking failed for a: config boom')).toHaveLength(1);
  });

  it('keeps going when the WIP commit fails', async () => {
    const r = rig(1000, { wipFails: true });
    await r.turn(1100);
    expect(r.calls).toContain('stop');
    expect(r.tickets.get('a')).toMatchObject({ status: 'suspended_budget', stopCause: 'budget' });
    expect(r.mains.some((m) => m.includes('index locked'))).toBe(true);
  });

  it('a ledger write failure does not stop the advance and is told to the main once', async () => {
    const r = rig(1000, { ledgerFails: true });
    await r.turn(10);
    await r.turn(10);
    expect(r.mains.filter((m) => m.toLowerCase().includes('ledger'))).toHaveLength(1);
    expect(r.svc.usage('a')).toBeUndefined(); // nothing recorded: n/a
    expect(r.tickets.get('a')?.budget?.step).toBe('ok');
  });

  it('a raised limit puts the step back where the new percentage says', async () => {
    const r = rig();
    await r.turn(1000);
    r.svc.setLimit('a', 5000);
    expect(r.svc.usage('a')).toEqual({ used: 1000, limit: 5000, step: 'ok' });
  });

  it('setLimit landing on limit restarts the grace, and dropping below clears limitAt', async () => {
    const r = rig();
    await r.turn(1000);
    const first = r.tickets.get('a')?.budget?.limitAt;
    expect(first).toBeDefined();
    r.advance(4 * 60_000);
    r.svc.setLimit('a', 1200); // 83%: alert, no limitAt
    expect(r.tickets.get('a')?.budget).toEqual({ limit: 1200, step: 'alert' });
    r.svc.setLimit('a', 900); // 111%: limit again with a fresh limitAt
    const fresh = r.tickets.get('a')?.budget?.limitAt;
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(first);
    r.svc.setLimit('a', 1000);
    expect(r.tickets.get('a')?.budget?.limitAt).toBeDefined();
    r.svc.setLimit('a', 5000);
    expect(r.tickets.get('a')?.budget).toEqual({ limit: 5000, step: 'ok' });
  });

  it('overlapping calls for one agent run in order, effects once', async () => {
    const r = rig(1000, { wipSlow: true });
    r.write(850);
    const p1 = r.svc.onTurnComplete('a', { sessionId: 's', turn: 1 });
    r.write(300);
    const p2 = r.svc.onTurnComplete('a', { sessionId: 's', turn: 2 });
    await Promise.all([p1, p2]);
    const eff = r.calls.filter((c) => /^(wip|agent|main|restrict|stop|ask)/.test(c));
    expect(eff).toEqual([
      'wip:budget alert', 'agent:Budget alert', 'main:Agent "a" us',
      'restrict:budget', 'wip:budget stop', 'stop', 'ask:raise/close/recover',
    ]);
  });

  it('a rejecting WIP commit still restricts, stops and asks', async () => {
    const r = rig(1000, { wipRejects: true });
    await r.turn(2000);
    expect(r.calls).toContain('restrict:budget');
    expect(r.calls).toContain('stop');
    expect(r.calls).toContain('ask:raise/close/recover');
    expect(r.mains.some((m) => m.includes('wip boom'))).toBe(true);
    expect(r.tickets.get('a')).toMatchObject({ status: 'suspended_budget', stopCause: 'budget' });
  });

  it('a throwing restrict is told to the main and the stop still happens', async () => {
    const r = rig(1000, { restrictThrows: true });
    await r.turn(2000);
    expect(r.mains.some((m) => m.includes('restrict boom'))).toBe(true);
    expect(r.calls).toContain('stop');
    expect(r.calls).toContain('ask:raise/close/recover');
  });

  it('the grace stop takes one final read into the ledger, and skips it when the transcript is gone', async () => {
    const r = rig();
    await r.turn(1000);
    r.write(50); // written after the last turn, not yet read
    r.advance(5 * 60_000 + 1);
    await r.svc.tick();
    expect(r.svc.usage('a')).toEqual({ used: 1050, limit: 1000, step: 'stopped' });
    const g = rig();
    await g.turn(1000);
    rmSync(g.file);
    g.advance(5 * 60_000 + 1);
    await g.svc.tick();
    expect(g.svc.usage('a')).toEqual({ used: 1000, limit: 1000, step: 'stopped' }); // nothing invented
    expect(g.calls).toContain('stop');
  });

  it('a non-positive limit means no budget', async () => {
    const r = rig(0);
    expect(r.svc.usage('a')).toBeUndefined();
    await r.turn(500);
    await r.svc.tick();
    expect(r.calls).toEqual([]);
    const s = rig(1000);
    s.svc.setLimit('a', 0);
    s.svc.setLimit('a', Number.NaN);
    expect(s.tickets.get('a')?.budget).toEqual({ limit: 1000, step: 'ok' });
  });
});

describe('BudgetService.restart (a replacement agent takes the ticket over)', () => {
  it('sets a fresh budget at step ok whatever the old one was, and begin() then keeps it', () => {
    const r = rig();
    r.tickets.setBudget('a', { limit: 1000, step: 'stopped', limitAt: '2026-10-05T10:00:00Z' });
    r.svc.restart('a', 1590);
    expect(r.tickets.get('a')?.budget).toEqual({ limit: 1590, step: 'ok' });
    r.svc.begin('a', 777);
    expect(r.tickets.get('a')?.budget).toEqual({ limit: 1590, step: 'ok' });
    expect(r.calls).toContain('changed');
  });
  it('ignores an unusable limit and a ticket that does not exist', () => {
    const r = rig();
    r.svc.restart('a', 0);
    r.svc.restart('a', Number.NaN);
    expect(r.tickets.get('a')?.budget).toEqual({ limit: 1000, step: 'ok' });
    r.svc.restart('ghost', 5000);
    expect(r.tickets.get('ghost')).toBeUndefined();
  });
});

describe('BudgetService fix wave', () => {
  it('a ticket whose agent is not a live session of this run is never alerted, restricted or stopped', async () => {
    let live = true;
    const r = rig(1000, { live: () => live });
    await r.turn(1000);
    expect(r.svc.usage('a')?.step).toBe('limit');
    live = false; // the agent is gone (an earlier run, a renamed ticket): nobody to stop
    r.advance(5 * 60_000 + 1);
    await r.svc.tick();
    await r.turn(500);
    expect(r.svc.usage('a')?.step).toBe('limit');
    expect(r.calls.filter((c) => c === 'stop' || c.startsWith('ask:'))).toEqual([]);
    live = true;
    await r.svc.tick();
    expect(r.svc.usage('a')?.step).toBe('stopped');
  });

  it('the alert tells the agent where to write the handover note, before the limit refuses writing', async () => {
    const { ALERT_TEXT, HANDOVER_FILE } = await import('../src/server/budget/service');
    expect(HANDOVER_FILE).toBe('.andromedaconsole/handover.md');
    expect(ALERT_TEXT).toContain('.andromedaconsole/handover.md');
    expect(ALERT_TEXT).toContain('step_done');
  });

  it('a loop stop that blocked the ticket during the final WIP keeps its own cause', async () => {
    const r = rig();
    r.d.wipCommit = async (_s, reason) => {
      if (reason === 'budget stop' && r.tickets.get('a')?.status === 'in_progress') { r.tickets.setStopCause('a', 'loop'); r.tickets.move('a', 'blocked'); }
      return { ok: true };
    };
    await r.turn(1100);
    expect(r.tickets.get('a')).toMatchObject({ status: 'blocked', stopCause: 'loop' });
  });
});
