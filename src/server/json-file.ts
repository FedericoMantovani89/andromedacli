import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * The parsed JSON of a file, or `undefined` when it is missing, unreadable or damaged: a state file that cannot be read is treated as
 * "nothing saved", never as a reason to stop the console. The caller checks the shape of what it gets.
 * Use `readJsonState` where the next write would otherwise destroy a damaged file.
 */
export function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export type JsonState = { status: 'missing' } | { status: 'ok'; value: unknown } | { status: 'corrupt'; movedTo?: string };
/** Called when a file was set aside: the file and where it went. */
export type StateReport = (file: string, movedTo: string) => void;

export const MAX_CORRUPT_COPIES = 5;
const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** Deletes the oldest `<name>.corrupt-*` copies beyond the limit. */
function pruneCopies(path: string): void {
  const dir = dirname(path);
  const prefix = `${basename(path)}.corrupt-`;
  try {
    const copies = readdirSync(dir).filter((n) => n.startsWith(prefix)).sort();
    for (const n of copies.slice(0, Math.max(0, copies.length - MAX_CORRUPT_COPIES))) rmSync(join(dir, n), { force: true });
  } catch { /* leave them */ }
}

/**
 * Moves a file nobody can use to `<name>.corrupt-<yyyymmddThhmmssZ>` next to it (a number is added when that name is taken),
 * keeps at most five such copies, and tells `report`. Returns the new path, or undefined when the file could not be moved.
 */
export function setAside(path: string, report?: StateReport, now: () => Date = () => new Date()): string | undefined {
  const base = `${path}.corrupt-${stamp(now())}`;
  let moved = base;
  for (let n = 1; existsSync(moved); n++) moved = `${base}-${n + 1}`;
  try { renameSync(path, moved); } catch { return undefined; }
  pruneCopies(path);
  report?.(path, moved);
  return moved;
}

/**
 * Like `readJsonFile`, but tells a file that is not there from one that cannot be parsed: that one is set aside (never overwritten
 * by the next save) and reported. The caller then treats it as missing.
 */
export function readJsonState(path: string, report?: StateReport, now?: () => Date): JsonState {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return { status: 'missing' }; }
  try { return { status: 'ok', value: JSON.parse(text) }; } catch { /* damaged */ }
  const movedTo = setAside(path, report, now);
  return movedTo === undefined ? { status: 'corrupt' } : { status: 'corrupt', movedTo };
}
