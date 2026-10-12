import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/server/git/commit', () => ({ commitWip: vi.fn() }));

import { commitWip } from '../src/server/git/commit';
import { wipCommitFor, authorRunning, authorActive, spawnResult } from '../src/server/runtime/helpers';
import type { ProjectContainer } from '../src/server/runtime/services';
import type { SpawnOutcome } from '../src/server/agents/spawn';

const commit = vi.mocked(commitWip);

interface Fake { worktree?: string; state?: string }
function container(agents: Record<string, Fake>, running: string[], status: Record<string, string> = {}): ProjectContainer {
  const services: Record<string, unknown> = {
    registry: { get: (slug: string) => { const a = agents[slug]; return a ? { state: a.state, git: a.worktree ? { worktree: a.worktree } : undefined } : undefined; } },
    ptys: { status: (slug: string) => (running.includes(slug) ? 'running' : 'exited') },
    projectName: 'shop',
    secretPatterns: () => ['*.key'],
    ticketStatusOf: (slug: string) => status[slug],
  };
  return { get: (name: string) => services[name] } as unknown as ProjectContainer;
}

describe('wipCommitFor', () => {
  beforeEach(() => { commit.mockReset(); });

  it('reports no worktree for an agent without one', async () => {
    const r = await wipCommitFor(container({ a: {} }, []))('a', 'budget');
    expect(r).toEqual({ ok: false, detail: 'no worktree' });
    expect(commit).not.toHaveBeenCalled();
  });

  it('commits and returns the sha', async () => {
    commit.mockResolvedValue({ ok: true, sha: 'abc' });
    const r = await wipCommitFor(container({ a: { worktree: 'W' } }, []))('a', 'budget');
    expect(r).toEqual({ ok: true, sha: 'abc' });
    expect(commit).toHaveBeenCalledWith({ worktree: 'W', slug: 'a', project: 'shop', reason: 'budget', secretPatterns: ['*.key'] });
  });

  it('with onlyInProgress, leaves a ticket that is not in progress alone', async () => {
    const c = container({ a: { worktree: 'W' } }, [], { a: 'delivered' });
    expect(await wipCommitFor(c, { onlyInProgress: true })('a', 'limit')).toEqual({ ok: true });
    expect(commit).not.toHaveBeenCalled();
  });

  it('with onlyInProgress, commits a ticket in progress', async () => {
    commit.mockResolvedValue({ ok: true, sha: 'x' });
    const c = container({ a: { worktree: 'W' } }, [], { a: 'in_progress' });
    expect((await wipCommitFor(c, { onlyInProgress: true })('a', 'limit')).ok).toBe(true);
  });

  it('formats a failure with files, with a detail, or with the code alone', async () => {
    const c = container({ a: { worktree: 'W' } }, []);
    commit.mockResolvedValueOnce({ ok: false, code: 'secrets', files: ['a.key', 'b.key'] });
    expect(await wipCommitFor(c)('a', 'r')).toEqual({ ok: false, detail: 'secrets: a.key, b.key' });
    commit.mockResolvedValueOnce({ ok: false, code: 'failed', detail: 'boom' });
    expect(await wipCommitFor(c)('a', 'r')).toEqual({ ok: false, detail: 'failed: boom' });
    commit.mockResolvedValueOnce({ ok: false, code: 'merging' });
    expect(await wipCommitFor(c)('a', 'r')).toEqual({ ok: false, detail: 'merging' });
  });
});

describe('authorRunning and authorActive', () => {
  const c = container({ working: { state: 'working' }, interrupted: { state: 'interrupted' }, finished: { state: 'finished' }, stopped: { state: 'working' } }, ['working', 'interrupted', 'finished']);

  it('authorRunning: not interrupted and the process runs', () => {
    const f = authorRunning(c);
    expect(f('working')).toBe(true);
    expect(f('interrupted')).toBe(false);
    expect(f('finished')).toBe(true);
    expect(f('stopped')).toBe(false);
  });

  it('authorActive: also not finished', () => {
    const f = authorActive(c);
    expect(f('working')).toBe(true);
    expect(f('interrupted')).toBe(false);
    expect(f('finished')).toBe(false);
    expect(f('stopped')).toBe(false);
  });
});

describe('spawnResult', () => {
  it('maps a started or queued outcome to ok', () => {
    expect(spawnResult({ ok: true, status: 'started', slug: 'a' })).toEqual({ ok: true });
    expect(spawnResult({ ok: true, status: 'queued', position: 1, slug: 'a' })).toEqual({ ok: true });
  });
  it('uses params.reason as the detail', () => {
    const out: SpawnOutcome = { ok: false, httpStatus: 400, code: 'bad', params: { reason: 'why' } };
    expect(spawnResult(out)).toEqual({ ok: false, code: 'bad', detail: 'why' });
  });
  it('falls back to the code without a reason', () => {
    expect(spawnResult({ ok: false, httpStatus: 400, code: 'bad' })).toEqual({ ok: false, code: 'bad', detail: 'bad' });
    expect(spawnResult({ ok: false, httpStatus: 400, code: 'bad', params: { n: 1 } })).toEqual({ ok: false, code: 'bad', detail: 'bad' });
  });
});
