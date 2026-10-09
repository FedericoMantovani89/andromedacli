import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resourcePath } from '../paths';
import { writeJsonAtomic } from '../fs-atomic';

export type CatalogSource = 'remote' | 'cache' | 'shipped';
export interface CatalogResult<T> { data: T; source: CatalogSource; updated?: string }
/** Downloads a text file; rejects on any failure, timeout or a body over `maxBytes`. */
export type TextFetcher = (url: string, o: { timeoutMs: number; maxBytes: number }) => Promise<string>;

export const FETCH_TIMEOUT_MS = 8000;
export const FETCH_MAX_BYTES = 1024 * 1024;
/** After a failed download the shipped/cached data is kept this long before the next attempt (no hammering on every request). */
const RETRY_AFTER_FAILURE_MS = 60_000;

/** Where the shipped catalogs live (a top-level folder, like `prompts/`). */
export const catalogDir = (): string => resourcePath('catalog');

export function readShipped(file: string): unknown {
  return JSON.parse(readFileSync(resolve(catalogDir(), file), 'utf8'));
}

/** HTTPS (or local http) GET with a timeout and a size cap, reading the body as a stream so an endless answer is cut. */
export const fetchText: TextFetcher = async (url, { timeoutMs, maxBytes }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { accept: 'application/json' } });
    if (!res.ok || !res.body) throw new Error(`http ${res.status}`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error('too large');
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { void reader.cancel().catch(() => undefined); throw new Error('too large'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
};

/** Entries with an `id`: the second list wins on a clash, order of first appearance is kept. */
export function mergeById<E extends { id: string }>(shipped: readonly E[], remote: readonly E[]): E[] {
  const out = new Map<string, E>();
  for (const e of shipped) out.set(e.id, e);
  for (const e of remote) out.set(e.id, e);
  return [...out.values()];
}

export interface RemoteCatalogOptions<T> {
  name: string;
  shipped: T;
  /** '' means "use the shipped data only". */
  url(): string;
  cacheFile: string;
  cacheHours(): number;
  /** Returns the cleaned data, or undefined when the file is not a catalog at all. */
  validate(raw: unknown): T | undefined;
  /** Combines the shipped data with the downloaded one (the downloaded wins). */
  merge(shipped: T, remote: T): T;
  updatedOf?(data: T): string | undefined;
  fetch?: TextFetcher;
  now?(): number;
}

interface CacheFile { fetchedAt: string; url: string; raw: unknown }

/**
 * SPEC 12.2: a cache younger than `cacheHours` is used; otherwise the file is downloaded and cached; a failed download falls back to any
 * cache, and then to the shipped data. `load` never throws.
 */
export class RemoteCatalog<T> {
  private memo?: { key: string; until: number; result: CatalogResult<T> };
  private inflight?: Promise<CatalogResult<T>>;

  constructor(private readonly o: RemoteCatalogOptions<T>) {}

  private now(): number { return this.o.now ? this.o.now() : Date.now(); }

  private result(data: T, source: CatalogSource): CatalogResult<T> {
    const updated = this.o.updatedOf?.(data);
    return { data, source, ...(updated !== undefined ? { updated } : {}) };
  }

  private readCache(url: string): { data: T; at: number } | undefined {
    try {
      if (!existsSync(this.o.cacheFile)) return undefined;
      const f = JSON.parse(readFileSync(this.o.cacheFile, 'utf8')) as Partial<CacheFile>;
      if (f.url !== url || typeof f.fetchedAt !== 'string') return undefined; // a cache of another address is not this catalog
      const at = Date.parse(f.fetchedAt);
      const remote = this.o.validate(f.raw);
      if (!Number.isFinite(at) || remote === undefined) return undefined;
      return { data: this.o.merge(this.o.shipped, remote), at };
    } catch {
      return undefined;
    }
  }

  private async compute(force: boolean): Promise<{ result: CatalogResult<T>; retrySoon: boolean }> {
    const url = this.o.url();
    if (url === '') return { result: this.result(this.o.shipped, 'shipped'), retrySoon: false };
    const cached = this.readCache(url);
    const ttl = Math.max(1, this.o.cacheHours()) * 3_600_000;
    if (!force && cached && this.now() - cached.at < ttl) return { result: this.result(cached.data, 'cache'), retrySoon: false };
    try {
      const text = await (this.o.fetch ?? fetchText)(url, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: FETCH_MAX_BYTES });
      const raw: unknown = JSON.parse(text);
      const remote = this.o.validate(raw);
      if (remote === undefined) throw new Error('not a catalog');
      try {
        writeJsonAtomic(this.o.cacheFile, { fetchedAt: new Date(this.now()).toISOString(), url, raw } satisfies CacheFile);
      } catch { /* an unwritable cache only costs a download next time */ }
      return { result: this.result(this.o.merge(this.o.shipped, remote), 'remote'), retrySoon: false };
    } catch {
      return { result: cached ? this.result(cached.data, 'cache') : this.result(this.o.shipped, 'shipped'), retrySoon: true };
    }
  }

  /** The catalog now. `force` skips the cache age and the failure back-off (the refresh button). */
  load(force = false): Promise<CatalogResult<T>> {
    const key = `${this.o.url()}|${this.o.cacheHours()}`;
    if (!force && this.memo && this.memo.key === key && this.memo.until > this.now()) return Promise.resolve(this.memo.result);
    if (this.inflight && !force) return this.inflight;
    const run = this.compute(force).then(({ result, retrySoon }) => {
      // A downloaded or fresh cached answer is good for the cache period; the answer after a failed download is retried soon.
      const until = this.now() + (this.o.url() === '' ? 0 : retrySoon ? RETRY_AFTER_FAILURE_MS : Math.max(1, this.o.cacheHours()) * 3_600_000);
      this.memo = { key, until, result };
      return result;
    }).catch(() => this.result(this.o.shipped, 'shipped')).finally(() => { if (this.inflight === run) this.inflight = undefined; });
    this.inflight = run;
    return run;
  }
}
