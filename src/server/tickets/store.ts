import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../fs-atomic';
import type { Step } from './checklist';

export type TicketStatus = 'in_progress' | 'delivered';
export interface Ticket { slug: string; steps: Step[]; status: TicketStatus; blocked: boolean; blockedReason?: string; updatedAt: string }
export interface TicketProgress { done: number; total: number; blocked: boolean; status: TicketStatus }

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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
      return Array.isArray(t.steps) ? t : undefined; // a damaged file must not take the console down
    } catch {
      return undefined;
    }
  }

  private save(t: Ticket): Ticket {
    const next = { ...t, updatedAt: new Date().toISOString() };
    writeJsonAtomic(this.file(t.slug), next);
    return next;
  }

  private ensure(slug: string): Ticket {
    return this.get(slug) ?? { slug, steps: [], status: 'in_progress', blocked: false, updatedAt: '' };
  }

  setChecklist(slug: string, steps: Step[]): Ticket {
    return this.save({ ...this.ensure(slug), steps });
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

  setStatus(slug: string, status: TicketStatus): Ticket {
    return this.save({ ...this.ensure(slug), status });
  }

  progress(slug: string): TicketProgress | undefined {
    const t = this.get(slug);
    if (!t) return undefined;
    return { done: t.steps.filter((s) => s.done).length, total: t.steps.length, blocked: t.blocked, status: t.status };
  }
}
