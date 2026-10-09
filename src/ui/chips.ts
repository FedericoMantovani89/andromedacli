import type { Activity } from '../shared/activity';
import type { SessionInfo } from '../shared/protocol';
import { bindText, k } from './i18n-client';

export const STATE_KEYS: Record<Activity, string> = {
  starting: k('state.starting'),
  idle: k('state.idle'),
  working: k('state.working'),
  waiting_user: k('state.waiting_user'),
  queued: k('state.queued'),
  interrupted: k('state.interrupted'),
  studying: k('state.studying'),
  blocked: k('state.blocked'),
  finished: k('state.finished'),
  suspended: k('state.suspended'),
  dormant: k('status.dormant'),
};

/**
 * Where the ticket is in the review pipeline, as a chip: "In review", "Approved", "Merged"... and "Rework 1" while the author fixes
 * what a review found. Hidden until the ticket has left its first writing.
 */
export const TICKET_KEYS: Record<string, string> = {
  delivered: k('ticket.status.delivered'),
  in_review: k('ticket.status.in_review'),
  changes_requested: k('ticket.status.changes_requested'),
  approved: k('ticket.status.approved'),
  conflict: k('ticket.status.conflict'),
  merged: k('ticket.status.merged'),
  needs_user: k('ticket.status.needs_user'),
  released: k('ticket.status.released'),
  suspended_budget: k('ticket.status.suspended_budget'),
  blocked: k('ticket.status.blocked'),
  recovering: k('ticket.status.recovering'),
  suspended_limit: k('ticket.status.suspended_limit'),
};

function clear(el: HTMLElement): void {
  el.hidden = true;
  el.textContent = '';
  delete el.dataset.i18n;
  delete el.dataset.i18nParams;
}

export function applyTicket(el: HTMLElement, ticket: SessionInfo['ticket']): void {
  const key = !ticket ? undefined : ticket.status === 'in_progress' ? (ticket.round > 0 ? k('ticket.rework') : undefined) : TICKET_KEYS[ticket.status];
  if (!ticket || !key) {
    clear(el);
    el.className = 'panel-ticket';
    return;
  }
  el.hidden = false;
  el.className = `panel-ticket ${ticket.status}`;
  bindText(el, key, { round: ticket.round, max: ticket.maxRounds });
}

/** The checklist progress chip ("3/7"): empty and hidden until the agent has a checklist. */
export function applyProgress(el: HTMLElement, progress: SessionInfo['progress']): void {
  if (!progress) {
    clear(el);
    return;
  }
  el.hidden = false;
  bindText(el, k('panel.progress'), { done: progress.done, total: progress.total });
}

/** "N waiting for you" when the agent has items in the queue; hidden otherwise. */
export function applyWaiting(el: HTMLElement, n: number | undefined): void {
  if (!n) {
    clear(el);
    el.className = 'panel-waiting';
    return;
  }
  el.hidden = false;
  el.className = 'panel-waiting';
  bindText(el, k('panel.waiting'), { count: n });
}

const LOOP_KEYS: Record<1 | 2 | 3, string> = { 1: k('panel.loop.1'), 2: k('panel.loop.2'), 3: k('panel.loop.3') };

/** The loop chip: "Corrected", "Limited", "Stopped on a loop". Hidden while the agent is not looping. */
export function applyLoop(el: HTMLElement, loop: SessionInfo['loop']): void {
  if (!loop) {
    clear(el);
    el.className = 'panel-loop';
    return;
  }
  el.hidden = false;
  el.className = `panel-loop level${loop}`;
  bindText(el, LOOP_KEYS[loop]);
}

/**
 * The token budget chip ("Budget 62%"). Hidden when the agent has no budget; "n/a" only while a working agent with a ticket has none
 * (the transcript could not be read), never a zero.
 */
export function applyBudget(el: HTMLElement, info: Pick<SessionInfo, 'budget' | 'state' | 'ticket'>): void {
  const budget = info.budget;
  const usable = !!budget && Number.isFinite(budget.used) && Number.isFinite(budget.limit) && budget.limit > 0;
  if (budget && usable) {
    el.hidden = false;
    el.className = `panel-budget ${budget.step}`;
    bindText(el, k('panel.budget'), { percent: Math.round((budget.used / budget.limit) * 100) });
    return;
  }
  if (info.state === 'working' && info.ticket) {
    el.hidden = false;
    el.className = 'panel-budget';
    bindText(el, k('panel.budgetNotAvailable'));
    return;
  }
  clear(el);
  el.className = 'panel-budget';
}

function requestChip<T extends { id: string }>(el: HTMLElement, cls: string, list: T[], who: (r: T) => string, one: string, more: string): void {
  if (list.length === 0) {
    clear(el);
    el.className = cls;
    return;
  }
  el.hidden = false;
  el.className = cls;
  const first = list[0]!;
  if (list.length === 1) bindText(el, one, { who: who(first), id: first.id });
  else bindText(el, more, { who: who(first), id: first.id, more: list.length - 1 });
}

/**
 * The requests between agents (SPEC 10): "waiting for be-orders (TODO-7f3a15)" for a step that waits for an answer, and
 * "to answer for fe-pages (TODO-...)" for a question the agent still owes a reply to. Each chip is hidden when it has nothing.
 */
export function applyRequests(waitingEl: HTMLElement, owedEl: HTMLElement, requests: SessionInfo['requests']): void {
  requestChip(waitingEl, 'panel-requests waiting', requests?.waiting ?? [], (r) => r.to, k('panel.requests.waiting'), k('panel.requests.waitingMore'));
  requestChip(owedEl, 'panel-requests owed', requests?.owed ?? [], (r) => r.from, k('panel.requests.owed'), k('panel.requests.owedMore'));
}
