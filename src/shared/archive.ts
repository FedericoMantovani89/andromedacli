import type { Activity } from './activity';

/** Ticket statuses in which an agent is waiting for a decision or for its own flow: such an agent is never archived. */
const WAITING_TICKETS: readonly string[] = ['suspended_budget', 'suspended_limit', 'blocked', 'needs_user', 'recovering'];
/** An idle author whose work is out of its hands: delivered, or already merged. */
const DONE_TICKETS: readonly string[] = ['delivered', 'merged', 'released'];

/**
 * Whether an agent may be archived by hand: `finished`, or `idle` with a delivered or merged ticket. A running, queued, dormant,
 * interrupted or suspended agent, and one whose ticket waits for a decision, stays in the column. The server and the UI share it.
 */
export function canArchive(state: Activity, ticketStatus: string | undefined): boolean {
  if (ticketStatus !== undefined && WAITING_TICKETS.includes(ticketStatus)) return false;
  if (state === 'finished') return true;
  return state === 'idle' && ticketStatus !== undefined && DONE_TICKETS.includes(ticketStatus);
}
