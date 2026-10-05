import { existsSync, mkdirSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { git } from './git';

export class GitError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'GitError';
  }
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PLAN = /^[A-Za-z0-9._-]+$/;
const fwd = (p: string): string => p.replace(/\\/g, '/');

/** The repository's common git dir (shared by every worktree), as an absolute path. */
export async function commonDir(repo: string): Promise<string> {
  const r = await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (r.code !== 0) throw new GitError('git.notRepo', r.stderr.trim());
  return r.stdout.trim();
}

const repoLocks = new Map<string, Promise<unknown>>();

/**
 * One git-structure change at a time per repository (creating the plan branch, adding a worktree, writing the repository config):
 * four agents launched at once would otherwise race on the same refs and config lock.
 */
export function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const key = repo.replace(/\\/g, '/').toLowerCase();
  const run = (repoLocks.get(key) ?? Promise.resolve()).then(fn, fn);
  repoLocks.set(key, run.catch(() => undefined));
  return run;
}

/** The plan branch `plan/<plan>` is where agents' work will land (merged in Phase 4); it starts at the current HEAD. */
export function ensurePlanBranch(repo: string, plan: string): Promise<{ branch: string; created: boolean }> {
  return withRepoLock(repo, () => ensurePlanBranchUnlocked(repo, plan));
}

async function ensurePlanBranchUnlocked(repo: string, plan: string): Promise<{ branch: string; created: boolean }> {
  if (!PLAN.test(plan)) throw new GitError('git.badName', `invalid plan name ${plan}`);
  const branch = `plan/${plan}`;
  if ((await git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code !== 0) throw new GitError('git.noCommits');
  if ((await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0) return { branch, created: false };
  const r = await git(repo, ['branch', branch, 'HEAD']);
  if (r.code !== 0) throw new GitError('git.failed', r.stderr.trim());
  return { branch, created: true };
}

/** Keeps the console's own folder out of every commit, without touching the project's .gitignore. */
export async function excludeConsoleFolder(repo: string): Promise<void> {
  const file = join(await commonDir(repo), 'info', 'exclude');
  mkdirSync(dirname(file), { recursive: true });
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (!text.split(/\r?\n/).some((l) => l.trim() === '.console/')) appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}.console/\n`);
}

export const agentBranchFor = (plan: string, slug: string): string => `agent/${plan}/${slug}`;

/** `<repo>.worktrees/<slug>`: a sibling of the repository, so no path is ever inside another worktree (SPEC 9.2). */
export const worktreePathFor = (repo: string, slug: string): string => join(dirname(repo), `${basename(repo)}.worktrees`, slug);

/** What would stop an agent from getting a worktree, found without creating anything. Undefined means it can be created. */
export async function checkSpawnable(o: { repo: string; plan: string; slug: string; /** a reviewer: no branch of its own */ review?: boolean }): Promise<'git.notRepo' | 'git.noCommits' | 'git.worktreeExists' | undefined> {
  if ((await git(o.repo, ['rev-parse', '--git-dir'])).code !== 0) return 'git.notRepo';
  if ((await git(o.repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code !== 0) return 'git.noCommits';
  if (existsSync(worktreePathFor(o.repo, o.slug))) return 'git.worktreeExists';
  if (!o.review && (await git(o.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${agentBranchFor(o.plan, o.slug)}`])).code === 0) return 'git.worktreeExists';
  return undefined;
}

/**
 * A checkout of one commit with no branch (`--detach`), in the same sibling folder as agent worktrees: where a reviewer reads the
 * delivered work (SPEC 15.3). With no branch there is nothing to commit to.
 */
export function createReviewWorktree(o: { repo: string; slug: string; sha: string }): Promise<{ path: string }> {
  return withRepoLock(o.repo, async () => {
    if (!SLUG.test(o.slug)) throw new GitError('git.badName', `invalid slug ${o.slug}`);
    if (!/^[0-9a-f]{7,40}$/.test(o.sha)) throw new GitError('git.badName', `invalid commit ${o.sha}`);
    const path = worktreePathFor(o.repo, o.slug);
    if (existsSync(path)) throw new GitError('git.worktreeExists', `folder ${path} already exists`);
    mkdirSync(dirname(path), { recursive: true });
    const added = await git(o.repo, ['worktree', 'add', '-q', '--detach', fwd(path), o.sha]);
    if (added.code !== 0) {
      await removeWorktree(o.repo, path);
      throw new GitError('git.failed', added.stderr.trim());
    }
    return { path };
  });
}

/** Undoes a worktree the console made for an agent that never got going: folder, branch and its hook folder. Safe to repeat. */
export async function discardAgentWorktree(o: { repo: string; slug: string; branch: string; path: string }): Promise<void> {
  await removeWorktree(o.repo, o.path);
  await git(o.repo, ['branch', '-D', o.branch]);
  try {
    rmSync(join(await commonDir(o.repo), 'console-hooks', o.slug), { recursive: true, force: true });
  } catch { /* nothing to remove */ }
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', fwd(path)]);
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  await git(repo, ['worktree', 'prune']);
}

/**
 * agent/<plan>/<slug> from the plan branch, in <repo>.worktrees/<slug> (SPEC 9.2). Refuses an existing folder or branch;
 * anything it created is removed again if a later step fails.
 */
export function createAgentWorktree(o: { repo: string; plan: string; slug: string; /** an existing branch to check out instead of a new one */ branch?: string }): Promise<{ path: string; branch: string }> {
  return withRepoLock(o.repo, () => (o.branch === undefined ? createAgentWorktreeUnlocked(o) : resumeBranchWorktreeUnlocked({ ...o, branch: o.branch })));
}

/**
 * A replacement agent continues a stopped one (SPEC 16.5): its own folder, the EXISTING branch of the stopped agent. Git refuses a
 * branch that another worktree has checked out, so the old worktree must be gone first. A failure removes the folder, never the branch.
 */
async function resumeBranchWorktreeUnlocked(o: { repo: string; plan: string; slug: string; branch: string }): Promise<{ path: string; branch: string }> {
  if (!SLUG.test(o.slug)) throw new GitError('git.badName', `invalid slug ${o.slug}`);
  if (!/^[A-Za-z0-9._/-]+$/.test(o.branch) || o.branch.startsWith('-')) throw new GitError('git.badName', `invalid branch ${o.branch}`);
  const path = worktreePathFor(o.repo, o.slug);
  if (existsSync(path)) throw new GitError('git.worktreeExists', `folder ${path} already exists`);
  if ((await git(o.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${o.branch}`])).code !== 0) throw new GitError('git.failed', `branch ${o.branch} does not exist`);
  mkdirSync(dirname(path), { recursive: true });
  const added = await git(o.repo, ['worktree', 'add', '-q', fwd(path), o.branch]);
  if (added.code !== 0) {
    await removeWorktree(o.repo, path);
    throw new GitError('git.failed', added.stderr.trim());
  }
  try {
    await excludeConsoleFolder(o.repo);
  } catch (e) {
    await removeWorktree(o.repo, path);
    throw new GitError('git.failed', e instanceof Error ? e.message : String(e));
  }
  return { path, branch: o.branch };
}

async function createAgentWorktreeUnlocked(o: { repo: string; plan: string; slug: string }): Promise<{ path: string; branch: string }> {
  if (!SLUG.test(o.slug)) throw new GitError('git.badName', `invalid slug ${o.slug}`);
  const plan = await ensurePlanBranchUnlocked(o.repo, o.plan);
  const branch = agentBranchFor(o.plan, o.slug);
  const path = worktreePathFor(o.repo, o.slug);
  if (existsSync(path)) throw new GitError('git.worktreeExists', `folder ${path} already exists`);
  if ((await git(o.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0) {
    throw new GitError('git.worktreeExists', `branch ${branch} already exists`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const added = await git(o.repo, ['worktree', 'add', '-q', '-b', branch, fwd(path), plan.branch]);
  if (added.code !== 0) {
    await removeWorktree(o.repo, path);
    await git(o.repo, ['branch', '-D', branch]);
    throw new GitError('git.failed', added.stderr.trim());
  }
  try {
    await excludeConsoleFolder(o.repo);
  } catch (e) {
    await removeWorktree(o.repo, path);
    await git(o.repo, ['branch', '-D', branch]);
    throw new GitError('git.failed', e instanceof Error ? e.message : String(e));
  }
  return { path, branch };
}
