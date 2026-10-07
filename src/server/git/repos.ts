import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Whether `dir` is inside a git work tree (a project folder in the subfolder of a repository counts, as it always did). */
function insideRepo(dir: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: dir, stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false; // not a repository, or git is missing (the prerequisite checks report the latter)
  }
}

/**
 * The repositories a project can work in, as paths relative to the project root. `['']` is the project root itself (it is in a repository: the
 * normal case); otherwise the sub-folders, one level down, that hold a `.git` (a folder such as `abc-website` with `abc-fe` and
 * `abc-be` inside). Hidden folders and the console's own `*.worktrees` folders are skipped.
 */
export function discoverRepos(projectRoot: string): string[] {
  const root = resolve(projectRoot);
  if (insideRepo(root)) return [''];
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.endsWith('.worktrees'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  return names.filter((n) => existsSync(join(root, n, '.git')));
}

/** Absolute path of a repo given by its relative name (`''` or undefined: the project root). */
export const repoPathOf = (projectRoot: string, rel: string | undefined): string =>
  rel === undefined || rel === '' ? resolve(projectRoot) : join(resolve(projectRoot), rel);

export type ResolvedRepo =
  | { ok: true; rel: string; path: string }
  | { ok: false; code: 'git.notRepo' | 'git.repoRequired' | 'git.unknownRepo'; repos: string[] };

/**
 * Which repository an agent works in. With one repo available it is chosen by itself; with several the caller must name one. Only an
 * exact name from `discoverRepos` is accepted: a path, a trailing slash or `..` is `git.unknownRepo`, so nothing outside the project
 * folder can be reached through this value.
 */
export function resolveRepo(projectRoot: string, requested: string | undefined): ResolvedRepo {
  const repos = discoverRepos(projectRoot);
  if (repos.length === 0) return { ok: false, code: 'git.notRepo', repos };
  const wanted = requested ?? '';
  if (wanted === '') {
    const only = repos.length === 1 ? repos[0]! : undefined;
    return only === undefined ? { ok: false, code: 'git.repoRequired', repos } : { ok: true, rel: only, path: repoPathOf(projectRoot, only) };
  }
  return repos.includes(wanted) ? { ok: true, rel: wanted, path: repoPathOf(projectRoot, wanted) } : { ok: false, code: 'git.unknownRepo', repos };
}
