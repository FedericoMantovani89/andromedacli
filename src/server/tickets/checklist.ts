export interface Step {
  n: number; title: string; done: boolean; skipped?: boolean; note?: string; sha?: string;
  /** A question sent for this step is unanswered: the step stays open and `step_done` goes past it (SPEC 10). */
  waitingOn?: { requestId: string; to: string };
  /** Ids of the requests this step waited for and got answered: their `TODO-<id>` comments must be gone before it closes. */
  resolved?: string[];
}

export type ChecklistError =
  | 'too_short' | 'too_long' | 'empty_title' | 'no_study' | 'no_tests_first' | 'no_validation' | 'no_docs' | 'duplicate_titles' | 'changes_done' | 'changes_waiting';

export type ChecklistResult = { ok: true; steps: Step[] } | { ok: false; code: ChecklistError; detail: string };

export const MIN_STEPS = 5;
export const MAX_STEPS = 40;
export const MAX_TITLE = 200;

const STUDY = /^(study|studying|studio|studia)\b/i;
const TESTS = /^(tests?|testing|write\s+(the\s+)?tests?|scrivi\s+(i\s+)?test|test-first|define\s+how\s+to\s+verify|definisci\s+come\s+verificare|prove)\b/i;
const VALIDATION = /^(validation|validate|validazione|valida|validare)\b/i;
const DOCS = /^(update\s+(the\s+)?(docs?|documentation)|docs?|documentation|aggiorna\s+(la\s+)?documentazione|documentazione|aggiornamento\s+(della\s+)?documentazione)\b/i;

const fail = (code: ChecklistError, detail: string): ChecklistResult => ({ ok: false, code, detail });
const clean = (s: string): string => s.replace(/^\s*\d+[.)]\s*/, '').trim();

/**
 * Validates the mandatory skeleton (SPEC 8.2): study first, tests second, validation second to last, documentation last, at least
 * five steps. With `previous`, the completed steps must come back unchanged and in place; their sha, note and flags are kept.
 */
export function validateChecklist(items: string[], previous?: Step[]): ChecklistResult {
  if (!Array.isArray(items)) return fail('too_short', 'items must be a list of step titles');
  if (items.some((i) => typeof i !== 'string')) return fail('empty_title', 'every step must be a text');
  const titles = items.map(clean);
  if (titles.length > MAX_STEPS) return fail('too_long', `at most ${MAX_STEPS} steps`);
  if (titles.some((t) => t.length > MAX_TITLE)) return fail('too_long', `a step title is limited to ${MAX_TITLE} characters`);
  if (titles.some((t) => t === '')) return fail('empty_title', 'a step has no title');

  const kept = (previous ?? []).filter((s) => s.done);
  for (const s of kept) {
    if (titles[s.n - 1] !== s.title) return fail('changes_done', `step ${s.n} is already done and must stay "${s.title}"`);
  }

  const open = (previous ?? []).filter((s) => !s.done);
  for (const s of open) {
    if (s.waitingOn && !titles.includes(s.title)) return fail('changes_waiting', `step "${s.title}" is waiting for ${s.waitingOn.requestId} and must stay in the checklist`);
  }

  if (titles.length < MIN_STEPS) return fail('too_short', `at least ${MIN_STEPS} steps: study, tests, implementation, validation, documentation`);
  if (!STUDY.test(titles[0]!)) return fail('no_study', 'the first step must be the study of the code');
  if (!TESTS.test(titles[1]!)) return fail('no_tests_first', 'the second step must write the tests first (or define how to verify)');
  if (!VALIDATION.test(titles[titles.length - 2]!)) return fail('no_validation', 'the second to last step must be the validation (full test suite)');
  if (!DOCS.test(titles[titles.length - 1]!)) return fail('no_docs', 'the last step must update the documentation');
  const seen = new Set<string>();
  for (const t of titles) {
    const key = t.toLowerCase();
    if (seen.has(key)) return fail('duplicate_titles', `duplicate step "${t}"`);
    seen.add(key);
  }

  const steps: Step[] = titles.map((title, i) => {
    const old = kept.find((s) => s.n === i + 1);
    if (old) return { ...old, title };
    // An open step that waits for an answer (or already got one) keeps that, wherever its number moved.
    const carried = open.find((s) => s.title === title && (s.waitingOn !== undefined || s.resolved !== undefined));
    return {
      n: i + 1, title, done: false,
      ...(carried?.waitingOn ? { waitingOn: carried.waitingOn } : {}),
      ...(carried?.resolved ? { resolved: carried.resolved } : {}),
    };
  });
  return { ok: true, steps };
}
