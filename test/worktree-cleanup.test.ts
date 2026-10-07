import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupWorktree, type CleanupDeps } from '../src/server/git/cleanup';
import { StaleChecker } from '../src/server/git/stale';
import { createAgentWorktree } from '../src/server/git/worktree';
import { gitSync, makeRepo, removeDir, type TestRepo } from './git-helpers';

let made: TestRepo[] = [];
afterEach(() => { for (const m of made) removeDir(m.base); made = []; });

async function setup(o: { remote: boolean }) {
  const r = makeRepo({ remote: o.remote });
  made.push(r);
  const wt = await createAgentWorktree({ repo: r.repo, project: 'p', slug: 'work' });
  let removed = 0;
  let active = false;
  const deps: CleanupDeps = {
    repo: r.repo, project: 'p', secretPatterns: ['.env'],
    agentGit: (s) => (s === 'work' ? { worktree: wt.path, branch: wt.branch } : undefined),
    isActive: () => active, removed: () => { removed += 1; },
  };
  return { r, wt, deps, removed: () => removed, setActive: (v: boolean) => { active = v; } };
}

describe('cleanupWorktree', () => {
  it('commits uncommitted work, pushes the branch and only then removes the folder; the branch stays', async () => {
    const s = await setup({ remote: true });
    writeFileSync(join(s.wt.path, 'notes.txt'), 'wip\n');
    const out = await cleanupWorktree(s.deps, 'work');
    expect(out).toMatchObject({ status: 'ok', branch: s.wt.branch });
    expect(existsSync(s.wt.path)).toBe(false);
    expect(s.removed()).toBe(1);
    expect(gitSync(s.r.remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).toContain(s.wt.branch);
    expect(gitSync(s.r.repo, 'branch', '--list', s.wt.branch)).toContain(s.wt.branch);
    expect(gitSync(s.r.remote, 'log', '-1', '--format=%s', s.wt.branch)).toContain('wip:');
  }, 60_000);
  it('refuses without a remote and keeps the folder', async () => {
    const s = await setup({ remote: false });
    expect(await cleanupWorktree(s.deps, 'work')).toMatchObject({ status: 'refused', code: 'no_remote' });
    expect(existsSync(s.wt.path)).toBe(true);
    expect(s.removed()).toBe(0);
  }, 60_000);
  it('refuses a running agent and an unknown name', async () => {
    const s = await setup({ remote: true });
    s.setActive(true);
    expect(await cleanupWorktree(s.deps, 'work')).toEqual({ status: 'refused', code: 'still_active' });
    expect(await cleanupWorktree(s.deps, 'nobody')).toEqual({ status: 'refused', code: 'unknown' });
    expect(existsSync(s.wt.path)).toBe(true);
  }, 60_000);
  it('refuses with not_saved when a secret file cannot be committed', async () => {
    const s = await setup({ remote: true });
    writeFileSync(join(s.wt.path, '.env'), 'KEY=1\n');
    expect(await cleanupWorktree(s.deps, 'work')).toMatchObject({ status: 'refused', code: 'not_saved' });
    expect(existsSync(s.wt.path)).toBe(true);
  }, 60_000);
});

describe('StaleChecker', () => {
  const DAY = 24 * 60 * 60_000;
  const make = (c: { lastActiveAt?: string; stale?: boolean; commit?: number }, enabled = true) => {
    const told: string[] = []; const flags: [string, boolean][] = [];
    const checker = new StaleChecker({
      enabled: () => enabled, days: () => 10, now: () => 100 * DAY,
      candidates: () => [{ slug: 'a', worktree: 'x', ...(c.lastActiveAt ? { lastActiveAt: c.lastActiveAt } : {}), ...(c.stale ? { stale: true } : {}) }],
      latestCommitMs: async () => c.commit, setStale: (s, v) => { flags.push([s, v]); }, tellMain: (t) => { told.push(t); }, changed: () => undefined,
    });
    return { checker, told, flags };
  };
  it('flags an old worktree once and tells the main one message', async () => {
    const m = make({ lastActiveAt: new Date(80 * DAY).toISOString(), commit: 70 * DAY });
    expect(await m.checker.check()).toEqual(['a']);
    expect(m.flags).toEqual([['a', true]]);
    expect(m.told).toHaveLength(1);
    expect(m.told[0]).toContain('a (');
    const again = make({ lastActiveAt: new Date(80 * DAY).toISOString(), stale: true });
    expect(await again.checker.check()).toEqual([]);
    expect(again.told).toEqual([]);
  });
  it('the latest of activity and commit counts, a fresh one clears the flag, unknown is never stale, disabled does nothing', async () => {
    const fresh = make({ lastActiveAt: new Date(50 * DAY).toISOString(), commit: 95 * DAY, stale: true });
    expect(await fresh.checker.check()).toEqual([]);
    expect(fresh.flags).toEqual([['a', false]]);
    const unknown = make({});
    expect(await unknown.checker.check()).toEqual([]);
    expect(unknown.flags).toEqual([]);
    expect(await make({ commit: 1 }, false).checker.check()).toEqual([]);
  });
});
