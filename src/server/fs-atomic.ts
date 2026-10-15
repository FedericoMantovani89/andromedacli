import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Errors that a busy file (antivirus, the search indexer) gives for a moment on Windows. */
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
export const WRITE_ATTEMPTS = 5;
const PAUSES_MS = [20, 40, 80, 160];
let counter = 0;

/** A pause with no timer: the callers of `writeJsonAtomic` are synchronous. */
const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * Writes JSON through a temp file and a rename, so a crash never leaves a half-written file. The temp name is unique per call
 * (two writers never share one), the data is flushed to disk before the rename, and a busy-file error is retried a few times.
 * After the last attempt the temp file is removed and the original error is thrown; the previous file is untouched.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${++counter}`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  let lastError: unknown;
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    try {
      const fd = openSync(tmp, 'w');
      try { writeSync(fd, text, null, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, path);
      return;
    } catch (e) {
      lastError = e;
      const code = (e as NodeJS.ErrnoException).code;
      if (code === undefined || !RETRY_CODES.has(code) || attempt === WRITE_ATTEMPTS - 1) break;
      sleepSync(PAUSES_MS[attempt] ?? 160);
    }
  }
  try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
  throw lastError;
}

const TMP_NAME = /^.+\.tmp-\d+-\d+$/;

/** Deletes the temp files of a `writeJsonAtomic` that a crash left behind: only names it makes, only when older than `olderThanMs`. */
export function removeStaleTmp(dir: string, olderThanMs = 3_600_000, now = Date.now()): number {
  let removed = 0;
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  for (const n of names) {
    if (!TMP_NAME.test(n)) continue;
    try {
      if (now - statSync(join(dir, n)).mtimeMs < olderThanMs) continue;
      rmSync(join(dir, n), { force: true });
      removed++;
    } catch { /* busy or gone: next time */ }
  }
  return removed;
}
