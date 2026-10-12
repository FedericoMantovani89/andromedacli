import type { BudgetConfig } from '../config';
import type { TicketStore } from '../tickets/store';
import { turnEntry, type Ledger, type LedgerScope } from './ledger';
import type { ToolUseEvent, TranscriptEvent, TranscriptReader, UsageEvent } from '../claude-code/transcript';
import { KeyedQueue } from '../keyed-queue';
import { errorMessage } from '../../shared/guards';
import { MainTeller } from '../main-teller';

export type BudgetStep = 'ok' | 'alert' | 'limit' | 'stopped';
const ORDER: BudgetStep[] = ['ok', 'alert', 'limit', 'stopped'];

/** Where an agent writes its handover note, relative to its worktree (kept out of git by the console's exclude of `.andromedaconsole/`). */
export const HANDOVER_FILE = '.andromedaconsole/handover.md';

export const ALERT_TEXT = `Budget alert: you have used most of the token budget of this ticket. Write the handover note NOW to ${HANDOVER_FILE} in your worktree (what is done, what is missing, what you suspect is consuming the most): at the budget limit every tool except step_done is refused, so this is your only chance. Then close the step you are on with step_done. Do not start anything new.`;

export interface BudgetDeps {
  /** The per-ticket queue shared by every ticket service of the project; without it the service has its own. */
  queue?: KeyedQueue;
  tickets: TicketStore; ledger: Ledger; reader: TranscriptReader; project: string;
  /** The project folder: with `project` it scopes the ledger, which every project of the user shares. */
  root: string;
  config: () => BudgetConfig;
  now: () => number; // ms, injectable
  /** The transcript file of the agent, or undefined when not known yet. */
  transcriptOf(slug: string): string | undefined;
  /** The ticket's agent is a live session of this run (a ticket left by an earlier run, or renamed, has no session to act on). */
  isLive(slug: string): boolean;
  wipCommit(slug: string, reason: string): Promise<{ ok: true; sha?: string } | { ok: false; detail: string }>;
  tellAgent(slug: string, text: string): void;
  tellMain(text: string): void;
  restrict(slug: string, why: 'budget'): void; // guard restriction
  stop(slug: string): Promise<void>; // orderly close (finishAgent)
  /** Puts the stop decision in the queue. The answer handler is attached by `index.ts` (`budget/answers.ts`), not by the service. */
  askUser(q: { text: string; options: string[]; payload: unknown }): void;
  changed(): void;
}

const validLimit = (n: number): boolean => Number.isFinite(n) && n > 0;

export class BudgetService {
  private ledgerWarned = false;
  private readonly queue: KeyedQueue;
  private readonly lastSession = new Map<string, { sessionId: string; turn: number }>();
  private readonly toldMissing = new Set<string>();
  private readonly main = new MainTeller((text) => this.d.tellMain(text));

  constructor(private readonly d: BudgetDeps) { this.queue = d.queue ?? new KeyedQueue(); }

  private get scope(): LedgerScope { return { project: this.d.project, root: this.d.root }; }
  private used(slug: string): number { return this.d.ledger.totalFor(slug, this.scope).tokens; }

  /** A failure of the budget tracking itself, told to the main once per agent (the tracking must never fail silently). */
  reportFailure(slug: string, err: unknown): void {
    this.main.once(slug, `budget tracking failed for ${slug}: ${errorMessage(err)}`);
  }

  /** Runs one effect; a failure is told to the main (itself guarded) and the next effect still runs. */
  private async effect(slug: string, what: string, fn: () => unknown): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.main.tell(`Budget handling of "${slug}": the step "${what}" failed (${errorMessage(err)}).`);
    }
  }

  begin(slug: string, limit: number): void {
    if (!validLimit(limit)) return; // no usable limit means no budget (n/a)
    const t = this.d.tickets.get(slug);
    if (t?.budget) return; // a restarted server keeps the persisted step
    if (!t) this.d.tickets.setChecklist(slug, []); // `setBudget` needs a ticket file; an empty checklist is what a new ticket has
    this.d.tickets.setBudget(slug, { limit, step: 'ok' });
  }

  /**
   * A new agent takes a stopped ticket over (SPEC 16.5): a fresh budget at step `ok`, whatever the old one was (`begin` would keep the
   * stopped one). Its usage starts from zero because the ledger counts per agent name, and the replacement has a new name.
   */
  restart(slug: string, limit: number): void {
    if (!validLimit(limit) || !this.d.tickets.get(slug)) return;
    this.d.tickets.setBudget(slug, { limit, step: 'ok' });
    this.d.changed();
  }

  /** Undefined (n/a, never zero) without a budget or before the first turn this project recorded for the agent. Served from memory. */
  /** `ticket`: the agent's ticket when the caller has just read it (the state builder reads each file once). */
  usage(slug: string, ticket?: { budget?: { limit: number; step: BudgetStep } }): { used: number; limit: number; step: BudgetStep } | undefined {
    const b = (ticket ?? this.d.tickets.get(slug))?.budget;
    if (!b) return undefined;
    const total = this.d.ledger.totalFor(slug, this.scope);
    if (total.turns === 0) return undefined;
    return { used: total.tokens, limit: b.limit, step: b.step };
  }

  setLimit(slug: string, limit: number): void {
    if (!validLimit(limit)) return;
    const t = this.d.tickets.get(slug);
    if (!t?.budget) return;
    const used = this.used(slug);
    const c = this.d.config();
    const pct = (used / limit) * 100;
    const step: BudgetStep = pct >= c.limitPercent ? 'limit' : pct >= c.alertPercent ? 'alert' : 'ok';
    // A fresh `limitAt` restarts the grace; for ok/alert the field is dropped.
    this.d.tickets.setBudget(slug, { limit, step, ...(step === 'limit' ? { limitAt: new Date(this.d.now()).toISOString() } : {}) });
    this.d.changed();
  }

  /** Never rejects: a failure is told to the main once (`reportFailure`). */
  onTurnComplete(slug: string, session: { sessionId: string; turn: number }): Promise<TranscriptEvent[]> {
    return this.queue.run(slug, async () => {
      if (!this.d.tickets.get(slug)?.budget) return [];
      this.lastSession.set(slug, session);
      const events = this.readAndAppend(slug, session, true);
      await this.advance(slug);
      return events;
    }).catch((err) => { this.reportFailure(slug, err); return []; });
  }

  /** Called every 30 s: only the grace period can move a step without a turn. Never rejects. */
  async tick(): Promise<void> {
    let all: ReturnType<TicketStore['list']>;
    try { all = this.d.tickets.list(); } catch (err) { this.reportFailure('all agents', err); return; }
    for (const t of all) {
      if (t.budget?.step === 'limit' && t.status === 'in_progress' && this.d.isLive(t.slug)) {
        await this.queue.run(t.slug, () => this.advance(t.slug)).catch((err) => this.reportFailure(t.slug, err));
      }
    }
  }

  /** The agent is about to be resumed (`--resume`): what its transcript holds now was counted in an earlier run. */
  primeTranscript(slug: string): void {
    const file = this.d.transcriptOf(slug);
    if (file) this.d.reader.prime(file);
  }

  /** Reads the new transcript events and writes one ledger line. n/a (missing or unreadable file) writes nothing. */
  private readAndAppend(slug: string, session: { sessionId: string; turn: number }, reportMissing = false): TranscriptEvent[] {
    const file = this.d.transcriptOf(slug);
    const read = file ? this.d.reader.read(file) : ({ ok: false, code: 'missing' } as const);
    if (!read.ok) {
      // Without a transcript nothing is counted, so the budget cannot act: the main hears it once per agent.
      if (reportMissing && read.code === 'missing' && !this.toldMissing.has(slug)) {
        this.toldMissing.add(slug);
        try { this.d.tellMain(`budget is not enforced for ${slug}: no transcript found under ${file ?? '(no session id yet)'}`); } catch { /* ignore */ }
      }
      return [];
    }
    const usages = read.events.filter((e): e is UsageEvent => e.kind === 'usage');
    const tools = [...new Set(read.events.filter((e): e is ToolUseEvent => e.kind === 'tool_use').map((e) => e.name))];
    const entry = turnEntry({ project: this.d.project, root: this.d.root, agent: slug, session: session.sessionId, turn: session.turn, usages, tools, ts: new Date(this.d.now()).toISOString() });
    if (!entry) return read.events;
    try {
      this.d.ledger.append(entry);
    } catch {
      // The ledger is the record: a failed write must not break the turn or the advance.
      if (!this.ledgerWarned) {
        this.ledgerWarned = true;
        try { this.d.tellMain('The budget ledger could not be written; token usage may be under-counted until it can.'); } catch { /* ignore */ }
      }
    }
    return read.events;
  }

  private async advance(slug: string): Promise<void> {
    const ticket = this.d.tickets.get(slug);
    const b = ticket?.budget;
    // Only a ticket being written is the agent's to spend on: delivered, in review, suspended... are left alone (the step too).
    if (!ticket || ticket.status !== 'in_progress' || !b || !validLimit(b.limit)) return;
    // Nobody to alert, restrict or stop: a ticket whose agent is not a session of this run is left as it is.
    if (!this.d.isLive(slug)) return;
    const c = this.d.config();
    const used = this.used(slug);
    const pct = (used / b.limit) * 100;
    const graceOver = b.step === 'limit' && b.limitAt !== undefined && this.d.now() - Date.parse(b.limitAt) >= c.graceMinutes * 60_000;
    const target: BudgetStep = pct >= c.stopPercent || graceOver ? 'stopped' : pct >= c.limitPercent ? 'limit' : pct >= c.alertPercent ? 'alert' : 'ok';
    if (ORDER.indexOf(target) <= ORDER.indexOf(b.step)) return; // never back, never twice
    // Persist first: a crash in an effect must not make the same step fire again after a restart.
    this.d.tickets.setBudget(slug, { ...b, step: target, ...(target === 'limit' ? { limitAt: new Date(this.d.now()).toISOString() } : {}) });
    const reached = (s: BudgetStep): boolean => ORDER.indexOf(b.step) < ORDER.indexOf(s) && ORDER.indexOf(s) <= ORDER.indexOf(target);
    if (reached('alert')) await this.alert(slug, used, b.limit);
    if (reached('limit')) await this.effect(slug, 'restrict', () => this.d.restrict(slug, 'budget'));
    if (reached('stopped')) await this.stopNow(slug, b.limit);
    await this.effect(slug, 'changed', () => this.d.changed());
  }

  private async wip(slug: string, reason: string): Promise<{ ok: true } | { ok: false; detail: string }> {
    try {
      const r = await this.d.wipCommit(slug, reason);
      return r.ok ? { ok: true } : { ok: false, detail: r.detail };
    } catch (err) {
      return { ok: false, detail: errorMessage(err) };
    }
  }

  private async alert(slug: string, used: number, limit: number): Promise<void> {
    const wip = await this.wip(slug, 'budget alert');
    await this.effect(slug, 'tellAgent', () => this.d.tellAgent(slug, ALERT_TEXT));
    await this.effect(slug, 'tellMain', () => this.d.tellMain(`Agent "${slug}" used ${used} of ${limit} budget tokens${wip.ok ? '' : ` (the WIP commit failed: ${wip.detail})`}. It was told to close the step and write the handover note.`));
  }

  private async stopNow(slug: string, limit: number): Promise<void> {
    if (this.d.tickets.get(slug)?.status !== 'in_progress') return;
    // Final snapshot: whatever the transcript holds now goes into the ledger before the last commit (n/a is skipped, never zero).
    await this.effect(slug, 'final read', () => this.readAndAppend(slug, this.lastSession.get(slug) ?? { sessionId: 'final', turn: 0 }));
    const used = this.used(slug);
    const wip = await this.wip(slug, 'budget stop');
    if (!wip.ok) await this.effect(slug, 'tellMain', () => this.d.tellMain(`The final WIP commit of "${slug}" failed (${wip.detail}); its worktree may hold uncommitted work.`));
    // Only a ticket still being written gets the budget as its cause: one a loop stop blocked meanwhile keeps its own.
    await this.effect(slug, 'ticket move', () => {
      if (this.d.tickets.get(slug)?.status !== 'in_progress') return;
      this.d.tickets.setStopCause(slug, 'budget');
      this.d.tickets.move(slug, 'suspended_budget');
    });
    await this.effect(slug, 'stop', () => this.d.stop(slug));
    await this.effect(slug, 'askUser', () => this.d.askUser({
      text: `"${slug}" was stopped: it used ${used} of ${limit} budget tokens. Raise the budget, close the ticket, or start a recovery?`,
      options: ['raise', 'close', 'recover'], payload: { kind: 'budget_stop', ticket: slug, used, limit },
    }));
  }
}
