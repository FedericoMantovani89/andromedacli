/**
 * The life of a ticket after its checklist exists (SPEC 15). Status changes go through `canMove` only: an impossible change is
 * refused with a code, never applied silently.
 *
 *   in_progress -> delivered -> in_review -> approved -> merged -> released
 *                      |            |  \         |  \
 *                      |            |   \        |   +-> conflict -> in_progress
 *                      |            +----+-> changes_requested -> in_progress (the author fixes, 2 rounds at most)
 *                      +--> needs_user (the user decides) <-- from almost anywhere
 *
 *   in_progress -> suspended_budget (budget stop) | blocked (loop stop) | suspended_limit (usage limit)
 *   suspended_budget | blocked -> recovering (a recovery agent diagnoses) -> in_progress (a new agent restarts the ticket)
 *   recovering -> suspended_budget | blocked (the recovery ended without a report)
 *   suspended_budget | blocked | suspended_limit -> in_progress (restart directly; a limit is not a defect, so no recovery)
 */
export const TICKET_STATUSES = [
  'in_progress', 'delivered', 'in_review', 'changes_requested', 'approved', 'conflict', 'merged', 'needs_user', 'released',
  'suspended_budget', 'blocked', 'recovering', 'suspended_limit',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

const TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  in_progress: ['delivered', 'needs_user', 'suspended_budget', 'blocked', 'suspended_limit'],
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
  suspended_budget: ['in_progress', 'recovering', 'needs_user'],
  blocked: ['in_progress', 'recovering', 'needs_user'],
  // recovering -> suspended_budget | blocked: the recovery session ended without a report, so the ticket waits again as it was stopped
  recovering: ['in_progress', 'needs_user', 'suspended_budget', 'blocked'],
  suspended_limit: ['in_progress', 'needs_user'],
};

export const nextStatuses = (from: TicketStatus): TicketStatus[] => [...(TRANSITIONS[from] ?? [])];
export const canMove = (from: TicketStatus, to: TicketStatus): boolean => (TRANSITIONS[from] ?? []).includes(to);
