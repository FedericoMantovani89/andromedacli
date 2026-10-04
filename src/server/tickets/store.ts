import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../fs-atomic';
import type { Step } from './checklist';
import { canMove, type TicketStatus } from './flow';

export type { TicketStatus } from './flow';

export interface ReviewNote { severity: string; where?: string; text: string }
export interface Verdict { round: number; pass: boolean; reviewer: string; notes: ReviewNote[]; at: string }
export interface TestResult { ok: boolean; command: string; tail: string; sha: string; at: string }

export interface Ticket {
  slug: string;
  steps: Step[];
  status: TicketStatus;
  blocked: boolean;
  blockedReason?: string;
  updatedAt: string;
  /** What the main asked for (SPEC 15.2: the diff must answer it). */
  goal?: string;
  /** Review rounds that sent the ticket back to its author (0 until the first reopen). */
  round: number;
  verdicts: Verdict[];
  /** The console's own test run on the delivered commit. */
  tests?: TestResult;
  deliveredSha?: string;
  mergedSha?: string;
  reviewer?: string;
}
export interface TicketProgress { done: number; total: number; blocked: boolean; status: TicketStatus }

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_GOAL = 4000;
const REOPEN_FROM: TicketStatus[] = ['changes_requested', 'conflict', 'needs_user'];

/** One JSON file per agent under <repo>/.console/state/tickets/ (SPEC 23). */
export class TicketStore {
  private readonly dir: string;

  constructor(root: string) {
    this.dir = join(root, '.console', 'state', 'tickets');
  }

  private file(slug: string): string {
    if (!SLUG.test(slug)) throw new Error('ticket.badSlug');
    return join(this.dir, `${slug}.json`);
  }

  get(slug: string): Ticket | undefined {
    const file = this.file(slug);
    if (!existsSync(file)) return undefined;
    try {
      const t = JSON.parse(readFileSync(file, 'utf8')) as Ticket;
      if (!Array.isArray(t.steps)) return undefined; // a damaged file must not take the console down
      // Phase 3 files have no pipeline fields.
      return { ...t, round: typeof t.round === 'number' ? t.round : 0, verdicts: Array.isArray(t.verdicts) ? t.verdicts : [] };
    } catch {
      return undefined;
    }
  }

  /** Every ticket on disk (damaged files and files that are not tickets are skipped). */
  list(): Ticket[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .map((f) => /^([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/.exec(f)?.[1])
      .filter((slug): slug is string => slug !== undefined)
      .map((slug) => this.get(slug))
      .filter((t): t is Ticket => t !== undefined);
  }

  private save(t: Ticket): Ticket {
    const next = { ...t, updatedAt: new Date().toISOString() };
    writeJsonAtomic(this.file(t.slug), next);
    return next;
  }

  private ensure(slug: string): Ticket {
    return this.get(slug) ?? { slug, steps: [], status: 'in_progress', blocked: false, updatedAt: '', round: 0, verdicts: [] };
  }

  private existing(slug: string): Ticket {
    const t = this.get(slug);
    if (!t) throw new Error('ticket.missing');
    return t;
  }

  setChecklist(slug: string, steps: Step[]): Ticket {
    return this.save({ ...this.ensure(slug), steps });
  }

  setGoal(slug: string, goal: string): Ticket {
    return this.save({ ...this.ensure(slug), goal: goal.trim().slice(0, MAX_GOAL) });
  }

  setTests(slug: string, tests: TestResult): Ticket {
    return this.save({ ...this.existing(slug), tests });
  }

  /** Closes the next open step. Anything else is refused, so a repeated or out-of-order `step_done` cannot double-commit. */
  markDone(slug: string, n: number, o: { note?: string; sha?: string; skipped?: boolean }): Ticket {
    const t = this.get(slug);
    if (!t || t.steps.length === 0) throw new Error('ticket.missing');
    const next = t.steps.find((s) => !s.done);
    if (!next || next.n !== n) throw new Error('step.out_of_order');
    const closed: Step = { ...next, done: true };
    if (o.note !== undefined) closed.note = o.note;
    if (o.sha !== undefined) closed.sha = o.sha;
    if (o.skipped) closed.skipped = true;
    return this.save({ ...t, steps: t.steps.map((s) => (s.n === n ? closed : s)) });
  }

  block(slug: string, reason: string): Ticket {
    return this.save({ ...this.ensure(slug), blocked: true, blockedReason: reason });
  }

  unblock(slug: string): Ticket | undefined {
    const t = this.get(slug);
    if (!t) return undefined;
    const { blockedReason: _gone, ...rest } = t;
    return this.save({ ...rest, blocked: false });
  }

  /** The only way to change the status: it must be a legal step of the flow (`flow.ts`). */
  move(slug: string, to: TicketStatus, extra: { deliveredSha?: string; mergedSha?: string; reviewer?: string | undefined } = {}): Ticket {
    const t = this.existing(slug);
    if (!canMove(t.status, to)) throw new Error('ticket.badTransition');
    return this.save({ ...t, ...extra, status: to });
  }

  addVerdict(slug: string, v: { pass: boolean; reviewer: string; notes: ReviewNote[] }): Ticket {
    const t = this.existing(slug);
    return this.save({ ...t, verdicts: [...t.verdicts, { round: t.verdicts.length + 1, ...v, at: new Date().toISOString() }] });
  }

  /**
   * Gives the ticket back to its author: three steps are appended (fixes, validation, documentation), so the skeleton rules and the
   * delivery code of the first round apply unchanged, and the status returns to `in_progress`.
   */
  reopen(slug: string, o: { firstStep?: string } = {}): Ticket {
    const t = this.existing(slug);
    if (!REOPEN_FROM.includes(t.status) || !canMove(t.status, 'in_progress')) throw new Error('ticket.badTransition');
    const round = t.round + 1;
    const first = t.steps.length + 1;
    const added: Step[] = [`${o.firstStep ?? 'Review fixes'} (round ${round})`, `Validation (round ${round})`, `Update documentation (round ${round})`]
      .map((title, i) => ({ n: first + i, title, done: false }));
    const { blockedReason: _gone, ...rest } = t;
    return this.save({ ...rest, blocked: false, status: 'in_progress', round, steps: [...t.steps, ...added] });
  }

  progress(slug: string): TicketProgress | undefined {
    const t = this.get(slug);
    if (!t) return undefined;
    return { done: t.steps.filter((s) => s.done).length, total: t.steps.length, blocked: t.blocked, status: t.status };
  }
}
