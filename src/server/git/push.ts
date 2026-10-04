import { git } from './git';

export type PushResult = { ok: true } | { ok: true; skipped: 'no_remote' } | { ok: false; detail: string };

/** End of ticket: push only the agent's branch (the pre-push hook enforces it again). A repo without `origin` is not an error. */
export async function pushBranch(o: { worktree: string; branch: string }): Promise<PushResult> {
  const remotes = await git(o.worktree, ['remote']);
  if (!remotes.stdout.split(/\r?\n/).map((l) => l.trim()).includes('origin')) return { ok: true, skipped: 'no_remote' };
  const r = await git(o.worktree, ['push', '-u', 'origin', o.branch], { timeoutMs: 120_000 });
  return r.code === 0 ? { ok: true } : { ok: false, detail: (r.stderr || r.stdout).trim().slice(-800) };
}
