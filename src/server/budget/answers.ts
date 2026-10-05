import { canMove, type TicketStatus } from '../tickets/flow';
import type { BudgetStep } from './service';

export interface BudgetAnswerDeps {
  budget: { usage(slug: string): { used: number; limit: number; step: BudgetStep } | undefined };
  tickets: { get(slug: string): { status: TicketStatus } | undefined; move(slug: string, to: TicketStatus): unknown };
  /** `RecoveryService`: a recovery agent, or a new agent that takes the stopped ticket over (SPEC 16.5). */
  recovery: {
    start(ticket: string): Promise<{ ok: true; recovery: string; attempt: number } | { ok: false; code: string; detail?: string }>;
    restart(ticket: string, o: { limit: number }): Promise<{ ok: true; agent: string } | { ok: false; code: string; detail?: string }>;
  };
  tellMain(text: string): void;
  changed(): void;
}

/** How much a "raise" adds to the budget. */
export const RAISE_FACTOR = 1.5;

/** The raised budget: from the usage when it went past the limit, otherwise the raised budget could already be used up. */
export const raisedLimit = (limit: number, used: number): number => Math.round(Math.max(limit, used) * RAISE_FACTOR);

const refusal = (r: { code: string; detail?: string }): string => `${r.code}${r.detail ? `: ${r.detail}` : ''}`;

/**
 * The user's answer to a budget stop (the console's `decision` item, options raise / close / recover). Pure wiring: `index.ts` attaches
 * it to the queue item. A raise restarts the ticket with a new agent; a recovery starts the read-only recovery agent.
 */
export function budgetAnswerHandler(d: BudgetAnswerDeps): (answer: string, payload: { ticket: string }) => Promise<void> {
  return async (answer, payload) => {
    const slug = payload?.ticket;
    if (typeof slug !== 'string' || slug === '') return;
    switch (answer) {
      case 'raise': {
        const u = d.budget.usage(slug);
        if (!u) { d.tellMain(`The budget of "${slug}" could not be raised: the ticket has no budget.`); return; }
        const limit = raisedLimit(u.limit, u.used);
        const r = await d.recovery.restart(slug, { limit });
        d.tellMain(r.ok
          ? `The user raised the budget of "${slug}" to ${limit} tokens. A new agent "${r.agent}" takes the ticket over on the same branch, with the same checklist and a handover note.`
          : `The user raised the budget of "${slug}" to ${limit} tokens, but the new agent could not be started (${refusal(r)}).`);
        d.changed();
        return;
      }
      case 'close': {
        const t = d.tickets.get(slug);
        if (t?.status === 'recovering') {
          // A recovery session is working on it: closing now would leave that session reporting on a ticket that moved away.
          d.tellMain(`The user chose to close the ticket "${slug}" after its budget stop, but a recovery is running on it (recovering), so it was not closed. Its outcome decides; the user can close it afterwards.`);
          return;
        }
        if (t && canMove(t.status, 'needs_user')) {
          d.tickets.move(slug, 'needs_user');
          d.tellMain(`The user closed the ticket "${slug}" after its budget stop; it now waits for the user (needs_user).`);
          d.changed();
        } else {
          d.tellMain(`The user chose to close the ticket "${slug}" after its budget stop, but its status (${t?.status ?? 'unknown'}) cannot move to needs_user.`);
        }
        return;
      }
      case 'recover': {
        const r = await d.recovery.start(slug);
        d.tellMain(r.ok
          ? `The user asked for a recovery of "${slug}": the read-only recovery agent "${r.recovery}" (attempt ${r.attempt}) is diagnosing it. You will be told its outcome.`
          : `The user asked for a recovery of "${slug}", but it could not start (${refusal(r)}).`);
        d.changed();
        return;
      }
      default:
        return;
    }
  };
}
