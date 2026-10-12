import type { SpawnOutcome } from '../agents/spawn';
import { commitWip } from '../git/commit';
import type { ProjectContainer } from './services';

/**
 * The work-in-progress commit of an agent's worktree. Services are read when it is called, never when it is made.
 * `onlyInProgress`: a ticket that is not being written (delivered, in review) is left alone, its branch must not move.
 */
export function wipCommitFor(c: ProjectContainer, o: { onlyInProgress?: boolean } = {}): (slug: string, reason: string) => Promise<{ ok: true; sha?: string } | { ok: false; detail: string }> {
  return async (slug, reason) => {
    if (o.onlyInProgress && c.get('ticketStatusOf')(slug) !== 'in_progress') return { ok: true };
    const worktree = c.get('registry').get(slug)?.git?.worktree;
    if (!worktree) return { ok: false, detail: 'no worktree' };
    const r = await commitWip({ worktree, slug, project: c.get('projectName'), reason, secretPatterns: c.get('secretPatterns')() });
    return r.ok ? { ok: true, sha: r.sha } : { ok: false, detail: `${r.code}${r.files ? `: ${r.files.join(', ')}` : r.detail ? `: ${r.detail}` : ''}` };
  };
}

/** The author's session was not interrupted and its process runs (review). */
export function authorRunning(c: ProjectContainer): (slug: string) => boolean {
  return (slug) => c.get('registry').get(slug)?.state !== 'interrupted' && c.get('ptys').status(slug) === 'running';
}

/** Like `authorRunning`, and the author has not finished either (central run and merge). */
export function authorActive(c: ProjectContainer): (slug: string) => boolean {
  return (slug) => c.get('registry').get(slug)?.state !== 'interrupted' && c.get('registry').get(slug)?.state !== 'finished' && c.get('ptys').status(slug) === 'running';
}

/** A `spawnAgent` outcome as the services that start a reviewer, a recovery or a replacement want it. */
export function spawnResult(out: SpawnOutcome): { ok: true } | { ok: false; code: string; detail: string } {
  return out.ok ? { ok: true } : { ok: false, code: out.code, detail: out.params?.reason !== undefined ? String(out.params.reason) : out.code };
}
