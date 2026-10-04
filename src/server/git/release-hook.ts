import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git';
import { commonDir } from './worktree';

const MARKER = '# console-release-hook';

/**
 * The pre-push hook of the main repository (SPEC 9.1, 15.5): nobody pushes `main`, `master`, `develop`, `trunk`, `release/*` or a tag
 * except the console while it is releasing with the user's approval. The console proves it with a one-time token that exists only for
 * the duration of its own push; the push must also carry the same value in its environment. This stops accidents and a main that forgets the rules; it is not a secret against a process running as the user (the guard keeps agents and the main away from .git/console-hooks).
 */
const SCRIPT = `#!/bin/sh
${MARKER}: refuses pushes to protected branches and tags unless the console is releasing
tokenfile="$(git rev-parse --path-format=absolute --git-common-dir)/console-hooks/release-token"
allowed=0
if [ -n "$CONSOLE_RELEASE_TOKEN" ] && [ -f "$tokenfile" ] && [ "$(cat "$tokenfile")" = "$CONSOLE_RELEASE_TOKEN" ]; then allowed=1; fi
while read local_ref local_sha remote_ref remote_sha; do
  case "$remote_ref" in
    refs/heads/main|refs/heads/master|refs/heads/develop|refs/heads/trunk|refs/heads/release/*|refs/tags/*)
      if [ "$allowed" != "1" ]; then
        echo "console pre-push: $remote_ref is released by the console after the user approves it; refusing this push" >&2
        exit 1
      fi
      ;;
  esac
done
exit 0
`;

export type ReleaseHookResult = 'installed' | 'skipped_existing' | 'skipped_hookspath';

/**
 * Installs the hook in `<git-common-dir>/hooks/pre-push`, but only where it cannot get in the way: not over a hook the project has,
 * and not when `core.hooksPath` points somewhere else (husky and friends). In those cases the guard is still there.
 */
export async function installReleaseHook(repo: string): Promise<ReleaseHookResult> {
  const hooksPath = await git(repo, ['config', '--get', 'core.hooksPath']);
  if (hooksPath.stdout.trim() !== '') return 'skipped_hookspath';
  const dir = join(await commonDir(repo), 'hooks');
  const file = join(dir, 'pre-push');
  if (existsSync(file) && !readFileSync(file, 'utf8').includes(MARKER)) return 'skipped_existing';
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, SCRIPT, { encoding: 'utf8', mode: 0o755 });
  try { chmodSync(file, 0o755); } catch { /* not meaningful on Windows */ }
  return 'installed';
}

/** Runs `fn` with the one-time token in place; the token file is gone again when it returns or throws. */
export async function withReleaseToken<T>(repo: string, fn: (env: { CONSOLE_RELEASE_TOKEN: string }) => Promise<T>): Promise<T> {
  const dir = join(await commonDir(repo), 'console-hooks');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'release-token');
  const token = randomBytes(24).toString('hex');
  writeFileSync(file, token, 'utf8');
  try {
    return await fn({ CONSOLE_RELEASE_TOKEN: token });
  } finally {
    rmSync(file, { force: true });
  }
}
