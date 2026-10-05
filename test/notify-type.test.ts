import { describe, it, expect } from 'vitest';
import { eventTypeOf, type TypedItem } from '../src/server/notify/type';
import type { NotifyType } from '../src/shared/notify';

const table: [string, TypedItem, NotifyType][] = [
  ['a question', { kind: 'question' }, 'question'],
  ['a permission request', { kind: 'permission' }, 'permission'],
  ['the release confirmation', { kind: 'confirm', payload: { target: 'main' } }, 'release'],
  ['the weekly limit notice', { kind: 'decision', payload: { kind: 'weekly_limit' } }, 'weekly_limit'],
  ['a budget stop', { kind: 'decision', payload: { kind: 'budget_stop', ticket: 'job', used: 2, limit: 1 } }, 'budget'],
  ['a recovery that asks to raise the budget', { kind: 'decision', payload: { ticket: 'job', reason: 'recovery_raise', notes: [] } }, 'budget'],
  ['a recovery that asks to change the model', { kind: 'decision', payload: { ticket: 'job', reason: 'recovery_change_model', notes: [] } }, 'decision'],
  ['a ticket the review cannot move on', { kind: 'decision', payload: { ticket: 'job', reason: 'rejected twice', notes: [], verdicts: [] } }, 'ticket_stuck'],
  ['a merge that needs the user (same payload shape as the review)', { kind: 'decision', payload: { ticket: 'job', reason: 'merge conflict', notes: [] } }, 'ticket_stuck'],
  ['a decision without payload', { kind: 'decision' }, 'decision'],
  ['a decision with an unknown payload', { kind: 'decision', payload: { kind: 'something_new' } }, 'decision'],
  ['a decision with a payload that is not an object', { kind: 'decision', payload: 'text' }, 'decision'],
  ['a decision with a null payload', { kind: 'decision', payload: null }, 'decision'],
];

describe('eventTypeOf', () => {
  it.each(table)('%s', (_name, item, expected) => {
    expect(eventTypeOf(item)).toBe(expected);
  });
});
