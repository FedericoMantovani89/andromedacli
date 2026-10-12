import { git } from '../git/git';

export interface MarkerHit { file: string; line: number; id: string }

/**
 * The places in the worktree that still carry a `TODO-<id>` comment (tracked files and untracked files that are not ignored; the
 * console's own folder is left out because its checklist file names the id). `undefined`: git could not search, which is not the
 * same as "nothing found" (git grep answers 1 with no output for no match; anything else is a failure).
 */
export async function findMarkers(cwd: string, ids: string[]): Promise<MarkerHit[] | undefined> {
  if (ids.length === 0) return [];
  const args = ['grep', '-n', '-I', '-F', '--untracked', ...ids.flatMap((id) => ['-e', id]), '--', '.', ':(exclude).andromedaconsole'];
  const r = await git(cwd, args);
  // When git prints nothing, git() puts the exec error message in stderr: a single "Command failed: ..." line. A spawn failure
  // (for example a missing folder) also exits 1 with no output but carries a different message.
  const silent = r.stderr.trim() === '' || (/^Command failed: /.test(r.stderr.trim()) && !r.stderr.trim().includes('\n'));
  if (r.code === 1 && r.stdout.trim() === '' && silent) return [];
  if (r.code !== 0) return undefined;
  const hits: MarkerHit[] = [];
  for (const row of r.stdout.split(/\r?\n/)) {
    const m = /^(.*?):(\d+):(.*)$/.exec(row);
    if (!m) continue;
    const id = ids.find((x) => m[3]!.includes(x));
    if (id) hits.push({ file: m[1]!, line: Number(m[2]), id });
  }
  return hits;
}
