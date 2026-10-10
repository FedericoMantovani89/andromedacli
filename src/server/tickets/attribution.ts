/** One ticket of the batch a central run covered, in merge order: its merge commit and the files that merge changed. */
export interface BatchItem { slug: string; sha: string; files: string[] }

export type Attribution =
  | { kind: 'culprit'; slug: string; by: 'single' | 'files' | 'bisect' }
  | { kind: 'undecided'; reason: 'no_failing_files' | 'cannot_rerun' | 'base_red' | 'not_reproduced' };

const TEST_FILE = /[\w@.\\/-]+\.(?:test|spec)\.[cm]?[jt]sx?/g;
const FAILURE_LINE = /FAIL|❯|×|✗|✖|failed/i;

/** The test files a runner's output names on failure lines (vitest and jest style), once each, with forward slashes. */
export function failingTestFiles(tail: string): string[] {
  const found = new Set<string>();
  for (const line of tail.split(/\r?\n/)) {
    if (!FAILURE_LINE.test(line)) continue;
    for (const m of line.matchAll(TEST_FILE)) found.add(m[0].replace(/\\/g, '/').replace(/^\.\//, ''));
  }
  return [...found];
}

const stemOf = (path: string): string => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/, '').replace(/\.[^.]+$/, '');
};

/** A touched file belongs to a failing test when it is that test, or a source file the test is named after (`merge.ts` ↔ `merge-ticket.test.ts`). */
function related(testFile: string, touched: string): boolean {
  const norm = touched.replace(/\\/g, '/');
  if (norm === testFile) return true;
  const test = stemOf(testFile);
  const file = stemOf(norm);
  return file !== '' && (test === file || test.startsWith(`${file}-`) || test.startsWith(`${file}.`));
}

/**
 * Who broke a red central run. `batch` is what was merged since the last green tip, oldest first; `base` is the commit just before the
 * first of them. First the failing test files against the files each ticket touched; when that does not name exactly one ticket, a bisect
 * over the batch (`rerun(sha, files)` is green/red/undefined when it could not tell: it re-runs only the failing files at that commit).
 */
export async function attribute(o: {
  failing: string[];
  batch: BatchItem[];
  base: string;
  rerun?: (sha: string, files: string[]) => Promise<boolean | undefined>;
}): Promise<Attribution> {
  const { batch, failing } = o;
  if (batch.length === 1) return { kind: 'culprit', slug: batch[0]!.slug, by: 'single' };
  if (batch.length === 0 || failing.length === 0) return { kind: 'undecided', reason: 'no_failing_files' };
  const candidates = batch.filter((b) => b.files.some((f) => failing.some((t) => related(t, f))));
  if (candidates.length === 1) return { kind: 'culprit', slug: candidates[0]!.slug, by: 'files' };

  const rerun = o.rerun;
  if (!rerun) return { kind: 'undecided', reason: 'cannot_rerun' };
  const green = (sha: string): Promise<boolean | undefined> => rerun(sha, failing);
  const atBase = await green(o.base);
  if (atBase === undefined) return { kind: 'undecided', reason: 'cannot_rerun' };
  if (!atBase) return { kind: 'undecided', reason: 'base_red' };
  const atTip = await green(batch[batch.length - 1]!.sha);
  if (atTip === undefined) return { kind: 'undecided', reason: 'cannot_rerun' };
  if (atTip) return { kind: 'undecided', reason: 'not_reproduced' };
  // Position 0 is the base (green), position i is the i-th merge; the last one is red: find the first red.
  let lo = 0;
  let hi = batch.length;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const ok = await green(batch[mid - 1]!.sha);
    if (ok === undefined) return { kind: 'undecided', reason: 'cannot_rerun' };
    if (ok) lo = mid; else hi = mid;
  }
  return { kind: 'culprit', slug: batch[hi - 1]!.slug, by: 'bisect' };
}
