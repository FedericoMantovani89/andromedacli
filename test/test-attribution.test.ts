import { describe, expect, it } from 'vitest';
import { attribute, failingTestFiles, type BatchItem } from '../src/server/tickets/attribution';

const item = (slug: string, sha: string, files: string[]): BatchItem => ({ slug, sha, files });

describe('failingTestFiles', () => {
  it('reads the failing files of a vitest tail, once each, with forward slashes', () => {
    const tail = [
      ' ✓ test/ok.test.ts (3 tests) 12ms',
      ' ❯ test\\merge-ticket.test.ts (20 tests | 1 failed) 339ms',
      '   × merges one ticket 40ms',
      ' FAIL  test/merge-ticket.test.ts > merges one ticket',
      ' FAIL  test/review.test.ts > sends back',
      ' Test Files  2 failed | 10 passed (12)',
    ].join('\n');
    expect(failingTestFiles(tail)).toEqual(['test/merge-ticket.test.ts', 'test/review.test.ts']);
  });

  it('returns nothing when the output names no test file', () => {
    expect(failingTestFiles('npm ERR! code ELIFECYCLE\nsomething broke')).toEqual([]);
  });
});

describe('attribute', () => {
  const batch = [
    item('a', 's1', ['src/server/tickets/merge.ts', 'CHANGELOG.md']),
    item('b', 's2', ['src/ui/panels.ts']),
    item('c', 's3', ['src/server/tickets/review.ts']),
  ];

  it('blames the only ticket that touched the failing test or its subject', async () => {
    const r = await attribute({ failing: ['test/merge-ticket.test.ts'], batch, base: 's0' });
    expect(r).toEqual({ kind: 'culprit', slug: 'a', by: 'files' });
  });

  it('blames the ticket that changed the failing test file itself', async () => {
    const withTest = [...batch, item('d', 's4', ['test/zzz.test.ts'])];
    const r = await attribute({ failing: ['test/zzz.test.ts'], batch: withTest, base: 's0' });
    expect(r).toEqual({ kind: 'culprit', slug: 'd', by: 'files' });
  });

  it('a one-ticket batch is its own culprit even when the output names no file', async () => {
    const r = await attribute({ failing: [], batch: [batch[0]!], base: 's0' });
    expect(r).toEqual({ kind: 'culprit', slug: 'a', by: 'single' });
  });

  it('bisects over the batch when the files do not decide, re-running only the failing files', async () => {
    const calls: { sha: string; files: string[] }[] = [];
    const red = new Set(['s3', 's4']); // the break starts with the third merge
    const four = [...batch, item('d', 's4', ['README.md'])];
    const r = await attribute({
      failing: ['test/unrelated.test.ts'], batch: four, base: 's0',
      rerun: async (sha, files) => { calls.push({ sha, files }); return !red.has(sha); },
    });
    expect(r).toEqual({ kind: 'culprit', slug: 'c', by: 'bisect' });
    expect(calls.every((c) => c.files.join() === 'test/unrelated.test.ts')).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(4); // base, tip, then log2(4)
  });

  it('several tickets match the files: the bisect picks among them', async () => {
    const two = [item('a', 's1', ['src/server/tickets/merge.ts']), item('b', 's2', ['src/server/tickets/merge.ts'])];
    const r = await attribute({ failing: ['test/merge-ticket.test.ts'], batch: two, base: 's0', rerun: async (sha) => sha === 's0' || sha === 's1' });
    expect(r).toEqual({ kind: 'culprit', slug: 'b', by: 'bisect' });
  });

  it('is undecided when the base is already red (the break was there before the batch)', async () => {
    const r = await attribute({ failing: ['test/x.test.ts'], batch, base: 's0', rerun: async () => false });
    expect(r).toEqual({ kind: 'undecided', reason: 'base_red' });
  });

  it('is undecided when it cannot re-run, or a re-run cannot tell', async () => {
    expect(await attribute({ failing: ['test/x.test.ts'], batch, base: 's0' })).toEqual({ kind: 'undecided', reason: 'cannot_rerun' });
    expect(await attribute({ failing: ['test/x.test.ts'], batch, base: 's0', rerun: async () => undefined })).toEqual({ kind: 'undecided', reason: 'cannot_rerun' });
  });

  it('is undecided when no file is named and there is more than one ticket', async () => {
    expect(await attribute({ failing: [], batch, base: 's0', rerun: async () => true })).toEqual({ kind: 'undecided', reason: 'no_failing_files' });
  });

  it('is undecided when the whole batch is green at every step (a flaky or combined break)', async () => {
    const r = await attribute({ failing: ['test/x.test.ts'], batch, base: 's0', rerun: async () => true });
    expect(r).toEqual({ kind: 'undecided', reason: 'not_reproduced' });
  });
});
