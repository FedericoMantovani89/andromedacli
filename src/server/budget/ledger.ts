import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { UsageEvent } from './transcript';

export interface LedgerEntry {
  ts: string; project: string;
  /** The project folder (absolute). Absent on lines written before scopes existed: those never count for a scoped total. */
  root?: string;
  agent: string; session: string; turn: number; model?: string;
  in: number; out: number; cache_creation: number; cache_read: number; tools: string[]; cost: null;
}

/** Which project a budget belongs to: the ledger is shared by every project of the user, and agent names repeat across projects. */
export interface LedgerScope { project: string; root: string }

/** A project folder as the ledger compares it: resolved, and case-insensitive on Windows. */
export const normaliseRoot = (root: string): string => {
  const r = resolve(root);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/** What counts against a budget: new work. Cache reads inflate the total without it (they stay in the ledger). */
export const budgetTokens = (e: Pick<LedgerEntry, 'in' | 'out' | 'cache_creation'>): number => e.in + e.out + e.cache_creation;

type Total = { tokens: number; turns: number };
const scopedKey = (agent: string, s: LedgerScope): string => JSON.stringify([s.project, normaliseRoot(s.root), agent]);
const anyKey = (agent: string): string => JSON.stringify([agent]);

/** One JSONL file per month, one line per turn, never rewritten (SPEC 16.6). Values are per turn, so a restart zeroes nothing. */
export class Ledger {
  /** Totals per agent (unscoped) and per scope + agent: read from the files once, then kept up to date by `append`. */
  private index: Map<string, Total> | undefined;

  constructor(private readonly dir: string, private readonly now: () => Date = () => new Date()) {}

  private add(e: LedgerEntry): void {
    const index = this.index!;
    const keys = [anyKey(e.agent), ...(typeof e.root === 'string' && typeof e.project === 'string' ? [scopedKey(e.agent, { project: e.project, root: e.root })] : [])];
    for (const k of keys) {
      const t = index.get(k) ?? { tokens: 0, turns: 0 };
      index.set(k, { tokens: t.tokens + budgetTokens(e), turns: t.turns + 1 });
    }
  }

  append(e: LedgerEntry): void {
    mkdirSync(this.dir, { recursive: true });
    const stamp = Number.isNaN(Date.parse(e.ts)) ? this.now() : new Date(e.ts);
    const month = `${stamp.getUTCFullYear()}-${String(stamp.getUTCMonth() + 1).padStart(2, '0')}`;
    const path = join(this.dir, `${month}.jsonl`);

    // If file exists and doesn't end with newline, prepend one to separate from any torn previous line
    if (existsSync(path)) {
      const stats = statSync(path);
      if (stats.size > 0) {
        const fd = openSync(path, 'r');
        try {
          const buf = Buffer.alloc(1);
          readSync(fd, buf, 0, 1, stats.size - 1);
          if (buf[0] !== 0x0a) { // 0x0a is '\n'
            appendFileSync(path, '\n', 'utf8');
          }
        } finally {
          closeSync(fd);
        }
      }
    }

    appendFileSync(path, `${JSON.stringify(e)}\n`, 'utf8');
    if (this.index) this.add(e); // only once the line is on disk
  }

  /** Reads the files (every query; the totals use the in-memory index instead). With a scope only that project's lines count. */
  entries(filter: { agent?: string; scope?: LedgerScope } = {}): LedgerEntry[] {
    const scope = filter.scope ? { project: filter.scope.project, root: normaliseRoot(filter.scope.root) } : undefined;
    return this.readAll().filter((e) => (!filter.agent || e.agent === filter.agent)
      && (!scope || (e.project === scope.project && typeof e.root === 'string' && normaliseRoot(e.root) === scope.root)));
  }

  /** Budget tokens and turns of an agent; with a scope, only within that project. Files are read once, on the first query. */
  totalFor(agent: string, scope?: LedgerScope): Total {
    if (!this.index) {
      const index = new Map<string, Total>();
      // Build the map in a local variable; if readAll() throws, this.index stays undefined so the next call retries.
      for (const e of this.readAll()) {
        const keys = [anyKey(e.agent), ...(typeof e.root === 'string' && typeof e.project === 'string' ? [scopedKey(e.agent, { project: e.project, root: e.root })] : [])];
        for (const k of keys) {
          const t = index.get(k) ?? { tokens: 0, turns: 0 };
          index.set(k, { tokens: t.tokens + budgetTokens(e), turns: t.turns + 1 });
        }
      }
      this.index = index;
    }
    return { ...(this.index.get(scope ? scopedKey(agent, scope) : anyKey(agent)) ?? { tokens: 0, turns: 0 }) };
  }

  private readAll(): LedgerEntry[] {
    if (!existsSync(this.dir)) return [];
    const out: LedgerEntry[] = [];
    for (const f of readdirSync(this.dir).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort()) {
      for (const line of readFileSync(join(this.dir, f), 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        try {
          const e = JSON.parse(line) as LedgerEntry;
          if (
            typeof e.agent === 'string' &&
            typeof e.in === 'number' && Number.isFinite(e.in) &&
            typeof e.out === 'number' && Number.isFinite(e.out) &&
            typeof e.cache_creation === 'number' && Number.isFinite(e.cache_creation) &&
            typeof e.cache_read === 'number' && Number.isFinite(e.cache_read) &&
            typeof e.turn === 'number' &&
            Array.isArray(e.tools)
          ) out.push(e);
        } catch { /* a damaged line is skipped */ }
      }
    }
    return out;
  }
}

export function turnEntry(o: { project: string; root?: string; agent: string; session: string; turn: number; usages: UsageEvent[]; tools: string[]; ts: string }): LedgerEntry | undefined {
  if (o.usages.length === 0) return undefined;
  const sum = (f: (u: UsageEvent) => number): number => o.usages.reduce((n, u) => n + f(u), 0);
  return {
    ts: o.ts, project: o.project, ...(o.root !== undefined ? { root: o.root } : {}), agent: o.agent, session: o.session, turn: o.turn, model: o.usages[o.usages.length - 1]!.model,
    in: sum((u) => u.input), out: sum((u) => u.output), cache_creation: sum((u) => u.cacheCreation), cache_read: sum((u) => u.cacheRead),
    tools: o.tools, cost: null,
  };
}
