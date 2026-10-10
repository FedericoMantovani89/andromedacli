import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { validateChecklist, type Step } from '../src/server/tickets/checklist';
import { TicketStore } from '../src/server/tickets/store';
import { removeDir } from './git-helpers';

const ITEMS = ['Study the code', 'Tests first: ordering', 'Implement a', 'Implement b', 'Validation: run the suite', 'Update documentation'];
const W = { requestId: 'TODO-7f3a15', to: 'be-orders' };
let dir: string;
let store: TicketStore;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wait-')); store = new TicketStore(dir); });
afterEach(() => removeDir(dir));

function steps(items = ITEMS, previous?: Step[]): Step[] {
  const r = validateChecklist(items, previous);
  if (!r.ok) throw new Error(`${r.code}: ${r.detail}`);
  return r.steps;
}
const withTwoDone = (): void => {
  store.setChecklist('a', steps());
  store.markDone('a', 1, { note: 'study notes' });
  store.markDone('a', 2, {});
};

it('setWaiting marks only that step and it stays open', () => {
  withTwoDone();
  const t = store.setWaiting('a', 3, W);
  expect(t.steps.map((s) => s.waitingOn?.requestId)).toEqual([undefined, undefined, 'TODO-7f3a15', undefined, undefined, undefined]);
  expect(t.steps[2]!.done).toBe(false);
});
it('markDone closes the first open step that is not waiting, and refuses the waiting one', () => {
  withTwoDone();
  store.setWaiting('a', 3, W);
  const t = store.markDone('a', 4, {});
  expect(t.steps.map((s) => s.done)).toEqual([true, true, false, true, false, false]);
  expect(() => store.markDone('a', 3, {})).toThrow('step.out_of_order');
});
it('clearWaiting makes the step workable again and remembers the request in resolved', () => {
  withTwoDone();
  store.setWaiting('a', 3, W);
  const r = store.clearWaiting('a', 'TODO-7f3a15')!;
  expect(r.step).toMatchObject({ n: 3, resolved: ['TODO-7f3a15'] });
  expect(r.step.waitingOn).toBeUndefined();
  expect(store.markDone('a', 3, {}).steps[2]!.done).toBe(true);
});
it('clearWaiting of an unknown id does nothing', () => {
  withTwoDone();
  expect(store.clearWaiting('a', 'TODO-000000')).toBeUndefined();
});
it('a new checklist keeps the waiting mark of an open step, also when its number changes', () => {
  withTwoDone();
  store.setWaiting('a', 3, W);
  const previous = store.get('a')!.steps;
  const inserted = ['Study the code', 'Tests first: ordering', 'Answer TODO-aaaaaa', 'Implement a', 'Implement b', 'Validation: run the suite', 'Update documentation'];
  const next = steps(inserted, previous);
  expect(next.find((s) => s.title === 'Implement a')).toMatchObject({ n: 4, waitingOn: W });
  expect(next.find((s) => s.title === 'Answer TODO-aaaaaa')!.waitingOn).toBeUndefined();
});
it('a new checklist keeps the resolved ids of an open step', () => {
  withTwoDone();
  store.setWaiting('a', 3, W);
  store.clearWaiting('a', 'TODO-7f3a15');
  const next = steps(ITEMS, store.get('a')!.steps);
  expect(next[2]!.resolved).toEqual(['TODO-7f3a15']);
});
it('a new checklist that drops or renames a waiting step is refused', () => {
  withTwoDone();
  store.setWaiting('a', 3, W);
  const previous = store.get('a')!.steps;
  const renamed = ['Study the code', 'Tests first: ordering', 'Implement c', 'Implement b', 'Validation: run the suite', 'Update documentation'];
  expect(validateChecklist(renamed, previous)).toMatchObject({ ok: false, code: 'changes_waiting' });
});
