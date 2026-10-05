import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git';
import { commitWip } from './commit';
import { pushBranch } from './push';
import { commonDir, removeWorktree } from './worktree';

export type CleanupCode = 'not_saved' | 'push_failed' | 'no_remote' | 'still_active' | 'unknown';
export type CleanupResult = { status: 'ok'; removed: string; branch: string } | { status: 'refused'; code: CleanupCode; detail?: string };

export interface CleanupDeps {
  repo: string;
  plan: string;
  secretPatterns: string[];
  /** The agent's worktree and branch as the console knows them; undefined for an unknown agent or one with no worktree. */
  agentGit(slug: string): { worktree: string; branch: string } | undefined;
  /** The agent's process is running, or its ticket is under review (its branch must not move). */
  isActive(slug: string): boolean;
  /** Called once the folder is gone: the record keeps the branch but no longer a worktree. */
  removed(slug: string): void;
}

/**
 * Tool `worktree_cleanup` (SPEC 9.9). The console always runs the safety checks itself: uncommitted changes become a WIP commit, the
 * branch is pushed when its commits are not on the remote, and only when the branch is on the remote is the folder removed. The
 * branch, its ticket and its record stay; a branch is never deleted here.
 */
export async function cleanupWorktree(d: CleanupDeps, slug: string): Promise<CleanupResult> {
  const where = d.agentGit(slug);
  if (!where) return { status: 'refused', code: 'unknown' };
  if (d.isActive(slug)) return { status: 'refused', code: 'still_active' };

  const wip = await commitWip({ worktree: where.worktree, slug, plan: d.plan, reason: 'cleanup', secretPatterns: d.secretPatterns });
  if (!wip.ok) return { status: 'refused', code: 'not_saved', detail: `${wip.code}${wip.files ? `: ${wip.files.join(', ')}` : wip.detail ? `: ${wip.detail}` : ''}` };

  const remotes = await git(where.worktree, ['remote']);
  if (!remotes.stdout.split(/\r?\n/).map((l) => l.trim()).includes('origin')) return { status: 'refused', code: 'no_remote' };

  const onRemote = async (): Promise<boolean> => {
    const head = await git(where.worktree, ['rev-parse', 'HEAD']);
    const remote = await git(where.worktree, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${where.branch}`]);
    return head.code === 0 && remote.code === 0 && head.stdout.trim() === remote.stdout.trim();
  };
  if (!(await onRemote())) {
    const pushed = await pushBranch({ worktree: where.worktree, branch: where.branch });
    if (!pushed.ok) return { status: 'refused', code: 'push_failed', detail: pushed.detail };
    if ('skipped' in pushed || !(await onRemote())) return { status: 'refused', code: 'push_failed', detail: 'the branch is not on the remote after the push' };
  }

  await removeWorktree(d.repo, where.worktree);
  try { rmSync(join(await commonDir(d.repo), 'console-hooks', slug), { recursive: true, force: true }); } catch { /* nothing to remove */ }
  d.removed(slug);
  return { status: 'ok', removed: where.worktree, branch: where.branch };
}
