import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../git/git';
import { changedFiles, ensureProjectWorktree, withProjectLock } from '../git/merge';
import { repoPathOf } from '../git/repos';
import { worktreesDirFor } from '../git/worktree';
import type { CentralGit, CentralTicket } from './central';
import type { TestJob, TestRun } from './test-queue';

/**
 * The command that re-runs only some test files, derived from the project's own tooling: the console cannot add file names to an
 * arbitrary command (`npm test a.test.ts` hands them to the last command of the script). Undefined when the runner is not known.
 */
export function pointedCommand(worktree: string, files: string[]): string | undefined {
  if (files.length === 0 || files.some((f) => !/^[\w@./-]+$/.test(f))) return undefined;
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try { pkg = JSON.parse(readFileSync(join(worktree, 'package.json'), 'utf8')); } catch { return undefined; }
  const has = (n: string): boolean => pkg.dependencies?.[n] !== undefined || pkg.devDependencies?.[n] !== undefined;
  if (has('vitest')) return `npx vitest run ${files.join(' ')}`;
  if (has('jest')) return `npx jest ${files.join(' ')}`;
  return undefined;
}

const lstatIsLink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** The real git behind `CentralRun`: the project worktree of a repository, merge order, and the bisect checkouts. */
export function createCentralGit(o: {
  root: string;
  project: string;
  /** Through the machine's test queue. */
  runTests(job: TestJob): Promise<TestRun>;
  timeoutMs(): number;
  /** A test seam: the command that re-runs `files` in `worktree`. */
  rerunCommand?(worktree: string, files: string[], command: string): string | undefined;
}): CentralGit {
  const pathOf = (rel: string): string => repoPathOf(o.root, rel);
  const branch = `project/${o.project}`;

  return {
    lock: (rel, fn) => withProjectLock(pathOf(rel), fn),

    async prepare(rel) {
      const repo = pathOf(rel);
      const wt = await ensureProjectWorktree(repo, o.project, worktreesDirFor(o.root, repo));
      if (!wt.ok) return undefined;
      const tip = (await git(wt.path, ['rev-parse', 'HEAD'])).stdout.trim();
      return /^[0-9a-f]{40}$/.test(tip) ? { path: wt.path, tip } : undefined;
    },

    async order(rel, tickets) {
      const log = await git(pathOf(rel), ['rev-list', '--first-parent', '--reverse', `refs/heads/${branch}`]);
      const index = new Map(log.stdout.split(/\r?\n/).filter(Boolean).map((sha, i) => [sha, i] as const));
      const at = (t: CentralTicket): number => index.get(t.mergedSha ?? '') ?? Number.MAX_SAFE_INTEGER;
      return [...tickets].sort((a, b) => at(a) - at(b));
    },

    async touched(rel, t) {
      if (!t.mergedSha) return [];
      return ((await changedFiles(pathOf(rel), `${t.mergedSha}^`, t.mergedSha)) ?? []).map((f) => f.path);
    },

    async withCheckout(rel, sha, fn) {
      const repo = pathOf(rel);
      const main = await ensureProjectWorktree(repo, o.project, worktreesDirFor(o.root, repo));
      if (!main.ok) return undefined;
      const tmp = mkdtempSync(join(tmpdir(), 'central-run-'));
      const dir = join(tmp, 'checkout');
      try {
        const added = await git(repo, ['worktree', 'add', '--detach', '-q', dir, sha]);
        if (added.code !== 0) return undefined;
        const modules = join(main.path, 'node_modules');
        // The installed dependencies of the project worktree are shared, read-only: a fresh checkout has none.
        if (existsSync(modules) && !existsSync(join(dir, 'node_modules'))) {
          try { symlinkSync(modules, join(dir, 'node_modules'), 'junction'); } catch { /* the run then fails to start */ }
        }
        return await fn(dir);
      } finally {
        // Drop the link first: removing a junction never touches the project's real node_modules. If the link cannot go, the
        // checkout is left for the temp cleaner rather than risk a recursive delete through it.
        try { rmSync(join(dir, 'node_modules'), { force: true }); } catch { /* checked just below */ }
        if (!existsSync(join(dir, 'node_modules')) || !lstatIsLink(join(dir, 'node_modules'))) {
          await git(repo, ['worktree', 'remove', '--force', dir]);
          await git(repo, ['worktree', 'prune']);
          try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* the temp cleaner gets it later */ }
        }
      }
    },

    rerun(rel, sha, files, command) {
      return this.withCheckout(rel, sha, async (dir) => {
        const cmd = (o.rerunCommand ?? pointedCommand)(dir, files, command);
        if (!cmd) return undefined;
        const run = await o.runTests({ cwd: dir, command: cmd, timeoutMs: o.timeoutMs(), heavy: true, label: `central-bisect:${o.project}`, owner: `central:${o.project}` });
        if (run.cancelled) return undefined;
        if (run.ok) return true;
        // A run that could not even start (no runner installed, timeout) says nothing about the code.
        return run.timedOut || run.code === null ? undefined : false;
      });
    },
  };
}
