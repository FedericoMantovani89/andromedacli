import type { NotifyType } from '../../shared/notify';

/** The part of a queue item that decides its notification type. */
export interface TypedItem { kind: 'question' | 'permission' | 'confirm' | 'decision'; payload?: unknown }

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});

/** SPEC 20.1: which kind of event a queue item is. Pure; a table in test/notify-type.test.ts. */
export function eventTypeOf(item: TypedItem): NotifyType {
  if (item.kind === 'question') return 'question';
  if (item.kind === 'permission') return 'permission';
  if (item.kind === 'confirm') return 'release';
  const p = obj(item.payload);
  if (p.kind === 'weekly_limit') return 'weekly_limit';
  if (p.kind === 'budget_stop') return 'budget';
  if (typeof p.reason === 'string' && p.reason.startsWith('recovery_')) return p.reason === 'recovery_raise' ? 'budget' : 'decision';
  // The review pipeline's "needs your decision": a ticket rejected twice, or whose tests stay red (review.askUserAboutTicket).
  if (typeof p.ticket === 'string' && Array.isArray(p.notes)) return 'ticket_stuck';
  return 'decision';
}
