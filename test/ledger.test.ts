import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { budgetTokens, Ledger, turnEntry, type LedgerEntry } from '../src/server/budget/ledger';

const entry = (o: Partial<LedgerEntry> = {}): LedgerEntry => ({ ts: '2026-10-05T10:00:00.000Z', plan: 'p', agent: 'a', session: 's', turn: 1, in: 10, out: 5, cache_creation: 100, cache_read: 1000, tools: ['Edit'], cost: null, ...o });
const u = (id: string, i: number, o: number, cc: number, cr: number) => ({ kind: 'usage' as const, messageId: id, input: i, output: o, cacheCreation: cc, cacheRead: cr });

describe('Ledger', () => {
  it('appends one line per turn in the file of its month and reads them back in order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-led-'));
    const l = new Ledger(dir);
    l.append(entry({ ts: '2026-09-30T23:00:00.000Z', turn: 1 }));
    l.append(entry({ ts: '2026-10-01T00:00:01.000Z', turn: 2 }));
    expect(readdirSync(dir).sort()).toEqual(['2026-09.jsonl', '2026-10.jsonl']);
    expect(l.entries().map((e) => e.turn)).toEqual([1, 2]);
    expect(readFileSync(join(dir, '2026-10.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('skips damaged lines and filters by agent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-led-'));
    const l = new Ledger(dir);
    l.append(entry({ agent: 'a' }));
    l.append(entry({ agent: 'b', turn: 2 }));
    appendFileSync(join(dir, '2026-10.jsonl'), 'garbage\n');
    expect(l.entries({ agent: 'b' })).toHaveLength(1);
    expect(l.totalFor('a')).toEqual({ tokens: 10 + 5 + 100, turns: 1 });
  });

  it('recovers from torn writes: prepends newline if file does not end with one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-led-'));
    const l = new Ledger(dir);
    // Write a partial line without newline (torn write)
    appendFileSync(join(dir, '2026-10.jsonl'), '{"agent":"a","in":1');
    // Now append a valid entry; it should prepend a newline
    l.append(entry({ agent: 'c', turn: 5 }));
    // Only the valid entry should be read
    expect(l.entries()).toHaveLength(1);
    expect(l.entries()[0]!.agent).toBe('c');
    expect(l.totalFor('c')).toEqual({ tokens: 10 + 5 + 100, turns: 1 });
  });

  it('validates all numeric fields as finite numbers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-led-'));
    const l = new Ledger(dir);
    l.append(entry({ agent: 'valid' }));
    // Write a line missing the 'out' field
    appendFileSync(join(dir, '2026-10.jsonl'), JSON.stringify({ ts: '2026-10-05T10:00:00.000Z', plan: 'p', agent: 'bad', session: 's', turn: 1, in: 10, cache_creation: 100, cache_read: 1000, tools: ['Edit'], cost: null }) + '\n');
    // Only the valid entry should be read
    expect(l.entries()).toHaveLength(1);
    expect(l.entries()[0]!.agent).toBe('valid');
  });

  it('falls back to injected now() when ts is not a valid date', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-led-'));
    const nowDate = new Date('2026-11-15T00:00:00Z');
    const l = new Ledger(dir, () => nowDate);
    l.append(entry({ ts: 'not a date' }));
    // Should be in the file for November (the injected now() month)
    expect(readdirSync(dir).sort()).toEqual(['2026-11.jsonl']);
    expect(l.entries()).toHaveLength(1);
  });
});

describe('Ledger scopes and the in-memory index', () => {
  const A = { plan: 'shop-api', root: 'C:/w/shop' };
  const B = { plan: 'shop-api', root: 'C:/w/other-shop' };

  it('two scopes with the same agent name do not mix; old lines without root never match a scoped query', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-led-'));
    const l = new Ledger(dir);
    l.append(entry({ plan: A.plan, root: A.root, agent: 'fix-login' }));
    l.append(entry({ plan: B.plan, root: B.root, agent: 'fix-login', out: 1000 }));
    l.append(entry({ plan: 'shop-api', agent: 'fix-login', out: 5000 })); // an old line, written before scopes existed
    expect(l.totalFor('fix-login', A)).toEqual({ tokens: 115, turns: 1 });
    expect(l.totalFor('fix-login', B)).toEqual({ tokens: 1110, turns: 1 });
    expect(l.totalFor('fix-login', { plan: 'other', root: A.root })).toEqual({ tokens: 0, turns: 0 });
    expect(l.entries({ agent: 'fix-login', scope: A })).toHaveLength(1);
    expect(l.totalFor('fix-login')).toEqual({ tokens: 115 + 1110 + 5110, turns: 3 }); // unscoped: everything of that name
  });

  it('a root is compared normalised (resolved; case-insensitive on Windows)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-led-'));
    const l = new Ledger(dir);
    const root = join(tmpdir(), 'Some', 'Plan');
    l.append(entry({ plan: 'p', root, agent: 'a' }));
    expect(l.totalFor('a', { plan: 'p', root: join(root, '.') }).turns).toBe(1);
    if (process.platform === 'win32') expect(l.totalFor('a', { plan: 'p', root: root.toUpperCase() }).turns).toBe(1);
  });

  it('reads the files once: later totals come from memory and follow appends', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-led-'));
    const l = new Ledger(dir);
    l.append(entry({ ...A, agent: 'a' }));
    expect(l.totalFor('a', A)).toEqual({ tokens: 115, turns: 1 });
    rmSync(join(dir, '2026-10.jsonl')); // a second query must not need the file
    expect(l.totalFor('a', A)).toEqual({ tokens: 115, turns: 1 });
    l.append(entry({ ...A, agent: 'a', turn: 2 }));
    expect(l.totalFor('a', A)).toEqual({ tokens: 230, turns: 2 });
    expect(l.totalFor('a')).toEqual({ tokens: 230, turns: 2 });
  });

  it('a fresh ledger loads what an earlier run wrote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-led-'));
    new Ledger(dir).append(entry({ ...A, agent: 'a' }));
    expect(new Ledger(dir).totalFor('a', A)).toEqual({ tokens: 115, turns: 1 });
  });

  it('retries if the first load fails: index stays undefined until load succeeds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-led-'));

    // Create a custom Ledger subclass where readAll can fail once
    class FailingLedger extends Ledger {
      private readAllCallCount = 0;

      // We need to make this private method accessible by casting
      override totalFor(agent: string, scope?: any): any {
        const thisLedger = this as any;
        const originalReadAll = thisLedger.readAll.bind(this);

        // Replace readAll for the first call only
        if (this.readAllCallCount === 0) {
          this.readAllCallCount++;
          thisLedger.readAll = () => {
            throw new Error('EBUSY: device or resource busy');
          };
          try {
            return super.totalFor(agent, scope);
          } finally {
            // Restore for next call
            thisLedger.readAll = originalReadAll;
          }
        }

        return super.totalFor(agent, scope);
      }
    }

    const l = new FailingLedger(dir);
    l.append(entry({ ...A, agent: 'a' }));

    // First totalFor should throw
    expect(() => l.totalFor('a', A)).toThrow('EBUSY');

    // Second totalFor should succeed because the first call's error prevented index from being properly initialized
    expect(l.totalFor('a', A)).toEqual({ tokens: 115, turns: 1 });
  });
});

describe('budget tokens and turn entries', () => {
  it('does not count cache reads', () => { expect(budgetTokens(entry())).toBe(115); });

  it('sums the messages of a turn, and writes nothing for a turn without data', () => {
    const t = turnEntry({ plan: 'p', agent: 'a', session: 's', turn: 3, ts: 't', tools: ['Read', 'Edit'], usages: [u('m1', 10, 5, 100, 1000), u('m2', 1, 2, 3, 4)] });
    expect(t).toMatchObject({ in: 11, out: 7, cache_creation: 103, cache_read: 1004, tools: ['Read', 'Edit'], cost: null });
    expect(turnEntry({ plan: 'p', agent: 'a', session: 's', turn: 4, ts: 't', tools: [], usages: [] })).toBeUndefined();
    expect(turnEntry({ plan: 'p', root: 'C:/w/p', agent: 'a', session: 's', turn: 5, ts: 't', tools: [], usages: [u('m3', 1, 1, 1, 1)] })?.root).toBe('C:/w/p');
  });
});
