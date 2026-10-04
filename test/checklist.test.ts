import { describe, expect, it } from 'vitest';
import { validateChecklist, type Step } from '../src/server/tickets/checklist';

const GOOD = ['Study the code', 'Tests first: OrderStatusTest', 'Add the enum', 'Map the DTO', 'Validation: npx vitest run', 'Update documentation'];
const ok = (items: string[], previous?: Step[]) => {
  const r = validateChecklist(items, previous);
  if (!r.ok) throw new Error(`${r.code}: ${r.detail}`);
  return r.steps;
};
const code = (items: string[], previous?: Step[]): string => {
  const r = validateChecklist(items, previous);
  return r.ok ? 'ok' : r.code;
};

describe('validateChecklist skeleton', () => {
  it('accepts a valid English checklist and numbers the steps from 1', () => {
    const steps = ok(GOOD);
    expect(steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(steps.every((s) => !s.done)).toBe(true);
    expect(steps[0]!.title).toBe('Study the code');
  });
  it('accepts an Italian checklist', () => {
    expect(code(['Studio — trovato: entità Ordine', 'Test: OrdineStatoTest (rosso, atteso)', 'Aggiungere enum', 'Mappare il DTO', 'Validazione: mvn -q verify verde', 'Aggiorna documentazione (README)'])).toBe('ok');
  });
  it('ignores a leading "1." / "2)" the agent may add and trims', () => {
    const steps = ok(['1. Study it', ' 2) Tests first ', '3. Do it', '4. Do more', '5. Validation: run', '6. Update docs']);
    expect(steps[0]!.title).toBe('Study it');
    expect(steps[1]!.title).toBe('Tests first');
  });
  it('accepts the no-tests variant "define how to verify" as step 2', () => {
    expect(code(['Study', 'Define how to verify', 'Implement', 'Implement more', 'Validation: run', 'Update documentation'])).toBe('ok');
  });
  it('accepts exactly five items and rejects four', () => {
    expect(code(['Study', 'Tests', 'Validation', 'Docs'])).toBe('too_short');
    expect(code(['Study', 'Tests', 'Implement', 'Validation', 'Update docs'])).toBe('ok');
  });
  it.each([
    ['first is not study', ['Implement', 'Tests', 'Do', 'Do more', 'Validation', 'Update docs'], 'no_study'],
    ['second is not tests', ['Study', 'Implement first', 'Do', 'Do more', 'Validation', 'Update docs'], 'no_tests_first'],
    ['validation is not N-1', ['Study', 'Tests', 'Validation', 'Do more', 'Do', 'Update docs'], 'no_validation'],
    ['docs is not last', ['Study', 'Tests', 'Do', 'Do more', 'Update docs', 'Validation'], 'no_validation'],
    ['no docs step', ['Study', 'Tests', 'Do', 'Do more', 'Validation', 'Cleanup'], 'no_docs'],
    ['duplicate titles', ['Study', 'Tests', 'Do it', 'do it', 'Validation', 'Update docs'], 'duplicate_titles'],
    ['empty title', ['Study', 'Tests', '   ', 'Do', 'Validation', 'Update docs'], 'empty_title'],
    ['title too long', ['Study', 'Tests', 'x'.repeat(201), 'Do', 'Validation', 'Update docs'], 'too_long'],
    ['too many items', ['Study', 'Tests', ...Array.from({ length: 40 }, (_, i) => `Step ${i}`), 'Validation', 'Update docs'], 'too_long'],
  ])('rejects: %s', (_l, items, expected) => {
    expect(code(items)).toBe(expected);
  });
  it('rejects non-string items without throwing', () => {
    expect(code([1, null, 'x'] as unknown as string[])).not.toBe('ok');
    expect(code('not an array' as unknown as string[])).not.toBe('ok');
  });
  it('gives a detail that says what is wrong', () => {
    const r = validateChecklist(['Implement', 'Tests', 'Do', 'Do more', 'Validation', 'Update docs']);
    expect(!r.ok && r.detail).toMatch(/first/i);
  });
});

describe('validateChecklist re-set', () => {
  const done = (steps: Step[], upTo: number): Step[] => steps.map((s) => (s.n <= upTo ? { ...s, done: true, sha: `sha${s.n}`, note: `note${s.n}` } : s));
  it('keeps the done prefix with its sha and note', () => {
    const prev = done(ok(GOOD), 3);
    const steps = ok(GOOD, prev);
    expect(steps.slice(0, 3).every((s) => s.done)).toBe(true);
    expect(steps[2]!.sha).toBe('sha3');
    expect(steps[2]!.note).toBe('note3');
    expect(steps[3]!.done).toBe(false);
  });
  it('allows appending implementation steps before validation', () => {
    const prev = done(ok(GOOD), 3);
    const more = [...GOOD.slice(0, 4), 'One more step', ...GOOD.slice(4)];
    const steps = ok(more, prev);
    expect(steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(steps[3]!.done).toBe(false);
  });
  it('refuses changing the title of a completed step', () => {
    const prev = done(ok(GOOD), 3);
    const changed = [...GOOD];
    changed[2] = 'Something else entirely';
    expect(code(changed, prev)).toBe('changes_done');
  });
  it('refuses removing or reordering completed steps', () => {
    const prev = done(ok(GOOD), 3);
    expect(code(['Study the code', 'Add the enum', 'Tests first: OrderStatusTest', 'Map the DTO', 'Validation: npx vitest run', 'Update documentation'], prev)).toBe('changes_done');
    expect(code(['Study the code', 'Tests first: OrderStatusTest', 'Validation: npx vitest run', 'Update documentation', 'Update docs again'], prev)).toBe('changes_done');
  });
  it('still validates the skeleton on a re-set', () => {
    const prev = done(ok(GOOD), 2);
    expect(code(['Study the code', 'Tests first: OrderStatusTest', 'Add the enum', 'Validation: run', 'Cleanup'], prev)).toBe('no_docs');
  });
  it('a re-set without completed steps may change anything valid', () => {
    expect(code(['Study again', 'Tests again', 'Do', 'Do more', 'Validation', 'Update docs'], ok(GOOD))).toBe('ok');
  });
});
