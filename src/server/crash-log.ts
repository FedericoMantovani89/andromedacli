import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_BYTES = 1024 * 1024;
const MAX_LINES_PER_MINUTE = 20;
const MAX_STACK = 4096;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'string' ? e : (() => { try { return JSON.stringify(e) ?? String(e); } catch { return String(e); } })());
const stackOf = (e: unknown): string => (e instanceof Error && e.stack ? e.stack : messageOf(e)).slice(0, MAX_STACK);

/**
 * A log of what went wrong in the background, one JSON line each, in `file` (rotated to `<file>.1` above 1 MiB). More than 20 lines in a
 * minute are counted, not written, and the count is written when the next minute starts.
 */
export function createCrashLog(file: string, o: { now?: () => number; maxBytes?: number } = {}): (kind: string, error: unknown) => void {
  const now = o.now ?? Date.now;
  const maxBytes = o.maxBytes ?? MAX_BYTES;
  let windowStart = -Infinity;
  let written = 0;
  let skipped = 0;
  const append = (entry: Record<string, unknown>): void => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      try { if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`); } catch { /* no file yet */ }
      appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch { /* logging must never raise */ }
  };
  return (kind, error) => {
    const t = now();
    if (t - windowStart >= 60_000) {
      if (skipped > 0) append({ ts: new Date(t).toISOString(), kind: 'skipped', count: skipped });
      windowStart = t; written = 0; skipped = 0;
    }
    if (written >= MAX_LINES_PER_MINUTE) { skipped++; return; }
    written++;
    append({ ts: new Date(t).toISOString(), kind, message: messageOf(error), stack: stackOf(error) });
    console.error(`console: ${kind}: ${messageOf(error)}`);
  };
}

const installed = new Map<string, () => void>();

/** Logs an unhandled promise rejection and keeps the process running. `uncaughtException` keeps Node's default (log and exit): after one the state cannot be trusted. */
export function installProcessGuards(file: string): () => void {
  const existing = installed.get(file);
  if (existing) return existing;
  const log = createCrashLog(file);
  const handler = (reason: unknown): void => { log('unhandledRejection', reason); };
  process.on('unhandledRejection', handler);
  const remove = (): void => { process.off('unhandledRejection', handler); installed.delete(file); };
  installed.set(file, remove);
  return remove;
}
