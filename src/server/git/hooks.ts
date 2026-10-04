import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git';
import { commonDir, GitError, withRepoLock } from './worktree';

const BRANCH = /^[A-Za-z0-9._/-]+$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The pre-push script (SPEC 9.5): only the agent's own branch, never a force, a delete or a tag. */
const script = (branch: string): string => `#!/bin/sh
own="refs/heads/${branch}"
zero="0000000000000000000000000000000000000000"
while read local_ref local_sha remote_ref remote_sha; do
  if [ "$remote_ref" != "$own" ]; then
    echo "console pre-push: refusing to push $remote_ref (this worktree may only push ${branch})" >&2
    exit 1
  fi
  if [ "$local_sha" = "$zero" ]; then
    echo "console pre-push: refusing to delete a remote branch" >&2
    exit 1
  fi
  if [ "$remote_sha" != "$zero" ] && ! git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then
    echo "console pre-push: refusing a non-fast-forward push (force is not allowed)" >&2
    exit 1
  fi
done
exit 0
`;

/**
 * Installs the pre-push hook for ONE worktree: the script lives in the repository's common git dir (outside the worktree,
 * so the agent's files never contain it) and only that worktree's config points at it (extensions.worktreeConfig).
 * Note: `git push --no-verify` skips hooks; the guard denies that flag.
 */
export function installPushHook(o: { repo: string; worktree: string; branch: string; slug: string }): Promise<void> {
  return withRepoLock(o.repo, () => installPushHookUnlocked(o));
}

async function installPushHookUnlocked(o: { repo: string; worktree: string; branch: string; slug: string }): Promise<void> {
  if (!BRANCH.test(o.branch)) throw new GitError('git.badName', `invalid branch name ${o.branch}`);
  if (!SLUG.test(o.slug)) throw new GitError('git.badName', `invalid slug ${o.slug}`);
  const dir = join(await commonDir(o.repo), 'console-hooks', o.slug);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'pre-push');
  writeFileSync(file, script(o.branch), { encoding: 'utf8', mode: 0o755 });
  try { chmodSync(file, 0o755); } catch { /* not meaningful on Windows */ }
  const ext = await git(o.repo, ['config', 'extensions.worktreeConfig', 'true']);
  if (ext.code !== 0) throw new GitError('git.failed', ext.stderr.trim());
  const set = await git(o.worktree, ['config', '--worktree', 'core.hooksPath', dir.replace(/\\/g, '/')]);
  if (set.code !== 0) throw new GitError('git.failed', set.stderr.trim());
}
