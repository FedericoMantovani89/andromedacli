/**
 * The life of a ticket after its checklist exists (SPEC 15). Status changes go through `canMove` only: an impossible change is
 * refused with a code, never applied silently.
 *
 *   in_progress -> delivered -> in_review -> approved -> merged -> released
 *                      |            |  \         |  \
 *                      |            |   \        |   +-> conflict -> in_progress
 *                      |            +----+-> changes_requested -> in_progress (the author fixes, 2 rounds at most)
 *                      +--> needs_user (the user decides) <-- from almost anywhere
 */
export const TICKET_STATUSES = [
  'in_progress', 'delivered', 'in_review', 'changes_requested', 'approved', 'conflict', 'merged', 'needs_user', 'released',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

const TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  in_progress: ['delivered', 'needs_user'],
  delivered: ['in_review', 'needs_user'],
  // in_review -> delivered: the reviewer's session ended without a verdict, so the main may ask again
  in_review: ['approved', 'changes_requested', 'needs_user', 'delivered'],
  changes_requested: ['in_progress', 'needs_user'],
  // approved -> changes_requested: the merge itself turned the tests red and the ticket goes back to its author
  approved: ['merged', 'conflict', 'changes_requested', 'needs_user'],
  conflict: ['in_progress', 'needs_user'],
  merged: ['released'],
  // the user's word overrides the pipeline: back to the author, review again, approve as it is, or merged outside the console
  needs_user: ['in_progress', 'delivered', 'approved', 'merged'],
  released: [],
};

export const nextStatuses = (from: TicketStatus): TicketStatus[] => [...(TRANSITIONS[from] ?? [])];
export const canMove = (from: TicketStatus, to: TicketStatus): boolean => (TRANSITIONS[from] ?? []).includes(to);
