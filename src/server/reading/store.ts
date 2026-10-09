import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SLUG_RE } from '../../shared/slug';

export interface ReadingEntry {
  /** Per-agent sequence number, from 1. */
  n: number;
  at: string;
  text: string;
  /** The answer was cut to the size limit. */
  truncated?: true;
}

export interface ReadingOptions {
  maxTextBytes?: number;
  maxFileBytes?: number;
  keep?: number;
}


/**
 * The last answers of each session, for the "read" panel (SPEC 5.5). Kept in memory (last 50) and appended to a JSONL file
 * per agent, which is rewritten with the latest entries when it grows past the limit.
 */
export class ReadingStore {
  private readonly cache = new Map<string, ReadingEntry[]>();
  private readonly counters = new Map<string, number>();
  private readonly listeners: ((slug: string, e: ReadingEntry) => void)[] = [];
  private readonly maxText: number;
  private readonly maxFile: number;
  private readonly keep: number;

  constructor(private readonly dir: string, o: ReadingOptions = {}) {
    this.maxText = o.maxTextBytes ?? 200 * 1024;
    this.maxFile = o.maxFileBytes ?? 2 * 1024 * 1024;
    this.keep = o.keep ?? 50;
  }

  on(cb: (slug: string, e: ReadingEntry) => void): void { this.listeners.push(cb); }

  add(slug: string, text: string): void {
    if (!SLUG_RE.test(slug) || text.trim() === '') return;
    const list = this.load(slug);
    const entry: ReadingEntry = { n: (this.counters.get(slug) ?? 0) + 1, at: new Date().toISOString(), text };
    if (Buffer.byteLength(text) > this.maxText) {
      entry.text = Buffer.from(text).subarray(0, this.maxText).toString('utf8').replace(/�+$/, '');
      entry.truncated = true;
    }
    this.counters.set(slug, entry.n);
    list.push(entry);
    while (list.length > this.keep) list.shift();
    this.persist(slug, entry, list);
    for (const cb of this.listeners) cb(slug, entry);
  }

  list(slug: string): ReadingEntry[] {
    if (!SLUG_RE.test(slug)) return [];
    return [...this.load(slug)];
  }

  private file(slug: string): string { return join(this.dir, `${slug}.jsonl`); }

  private load(slug: string): ReadingEntry[] {
    const cached = this.cache.get(slug);
    if (cached) return cached;
    const entries: ReadingEntry[] = [];
    const file = this.file(slug);
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try { entries.push(JSON.parse(line) as ReadingEntry); } catch { /* a half-written last line */ }
      }
    }
    const tail = entries.slice(-this.keep);
    this.cache.set(slug, tail);
    this.counters.set(slug, tail.at(-1)?.n ?? 0);
    return tail;
  }

  private persist(slug: string, entry: ReadingEntry, list: ReadingEntry[]): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = this.file(slug);
      appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
      if (statSync(file).size > this.maxFile) {
        // Rewrite with the latest entries that fit in half the limit, so rotation does not happen on every append.
        const lines: string[] = [];
        let bytes = 0;
        for (const e of [...list].reverse()) {
          const line = JSON.stringify(e);
          if (lines.length > 0 && bytes + line.length + 1 > this.maxFile / 2) break;
          lines.unshift(line);
          bytes += line.length + 1;
        }
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, `${lines.join('\n')}\n`, 'utf8');
        renameSync(tmp, file);
      }
    } catch {
      /* the in-memory copy still serves the panel; disk trouble must not break the session */
    }
  }
}
