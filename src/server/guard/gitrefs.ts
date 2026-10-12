import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The branch a repository's HEAD points at (`main`), or undefined when detached or unreadable. Only a regular `.git` folder is read. */
export function headBranch(repo: string): string | undefined {
  try {
    const text = readFileSync(join(repo, '.git', 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

/** True when `name` (or `refs/tags/<name>`) is an existing tag of the repository: a loose ref or a line of packed-refs. */
export function isTag(repo: string, name: string): boolean {
  const tag = name.replace(/^refs\/tags\//, '');
  if (tag === '' || /[\s:*?[\\^~]/.test(tag) || tag.includes('..')) return false;
  try {
    if (existsSync(join(repo, '.git', 'refs', 'tags', ...tag.split('/')))) return true;
    const packed = join(repo, '.git', 'packed-refs');
    return existsSync(packed) && readFileSync(packed, 'utf8').split(/\r?\n/).some((l) => l.endsWith(` refs/tags/${tag}`));
  } catch {
    return false;
  }
}

/**
 * The commands git itself ships, plus the external ones agents use (`git lfs`). A subcommand outside this set can only be an alias
 * (or a program named `git-<name>` on the PATH): the guard cannot see what it runs, so it is refused (`git.alias`).
 */
export const GIT_BUILTINS: ReadonlySet<string> = new Set([
  'add', 'am', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle', 'cat-file', 'check-attr', 'check-ignore', 'checkout',
  'checkout-index', 'cherry', 'cherry-pick', 'citool', 'clean', 'clone', 'commit', 'commit-tree', 'config', 'count-objects', 'credential',
  'describe', 'diff', 'diff-files', 'diff-index', 'diff-tree', 'difftool', 'fast-export', 'fast-import', 'fetch', 'filter-branch',
  'for-each-ref', 'format-patch', 'fsck', 'gc', 'gui', 'hash-object', 'help', 'http-push', 'init', 'interpret-trailers', 'lfs',
  'log', 'ls-files', 'ls-remote', 'ls-tree', 'maintenance', 'merge', 'merge-base', 'mergetool', 'mktree', 'mv', 'name-rev', 'notes',
  'pack-refs', 'prune', 'prune-packed', 'pull', 'push', 'range-diff', 'read-tree', 'rebase', 'reflog', 'remote', 'repack', 'replace',
  'request-pull', 'reset', 'restore', 'rev-list', 'rev-parse', 'revert', 'rm', 'send-pack', 'shortlog', 'show', 'show-branch',
  'show-ref', 'sparse-checkout', 'stash', 'status', 'stripspace', 'submodule', 'switch', 'symbolic-ref', 'tag', 'unpack-file',
  'update-index', 'update-ref', 'var', 'verify-commit', 'verify-tag', 'version', 'whatchanged', 'worktree', 'write-tree',
]);
