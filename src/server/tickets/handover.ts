import { closeSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';

const HANDOVER_REL = ['.andromedacli', 'handover.md'] as const;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_CHARS = 4000;

const inside = (root: string, p: string): boolean => {
  const r = relative(root, p);
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
};

/**
 * The handover note an agent wrote in its worktree (`.andromedacli/handover.md`), at most 4000 characters. The agent is untrusted, so the
 * file must be a regular file (no symlink) of at most 64 KiB whose real path, and that of `.andromedacli`, stay inside the worktree; at
 * most 4000 characters worth of bytes are read. Never throws: any problem gives undefined.
 */
export function readHandoverNote(worktree: string): string | undefined {
  try {
    const dir = join(worktree, HANDOVER_REL[0]);
    const file = join(dir, HANDOVER_REL[1]);
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_FILE_BYTES) return undefined;
    const realRoot = realpathSync(worktree);
    if (!inside(realRoot, realpathSync(dir)) || !inside(realRoot, realpathSync(file))) return undefined;
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(MAX_CHARS * 4); // a character is at most 4 bytes in UTF-8
      const n = readSync(fd, buf, 0, Math.min(buf.length, st.size), 0);
      const text = buf.subarray(0, n).toString('utf8').slice(0, MAX_CHARS).trim();
      return text === '' ? undefined : text;
    } finally {
      closeSync(fd);
    }
  } catch { return undefined; }
}
