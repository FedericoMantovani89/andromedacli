import { canArchive } from '../../shared/archive';
import type { AgentRegistry } from './registry';

export type ArchiveOutcome = { ok: true } | { ok: false; code: 'not_found' | 'agent.notArchivable' };

/** Archives an agent by hand (the button of its panel). Only a flag moves: the session, worktree, transcript and ticket stay. */
export function archiveAgent(d: { registry: AgentRegistry; ticketStatus(slug: string): string | undefined }, slug: string): ArchiveOutcome {
  const a = d.registry.get(slug);
  if (!a) return { ok: false, code: 'not_found' };
  if (a.role === 'main' || !canArchive(a.state, d.ticketStatus(slug))) return { ok: false, code: 'agent.notArchivable' };
  d.registry.setArchived(slug, true);
  return { ok: true };
}

/** Brings an archived agent back to the column (a no-op for one that is not archived). */
export function unarchiveAgent(d: { registry: AgentRegistry }, slug: string): ArchiveOutcome {
  if (!d.registry.get(slug)) return { ok: false, code: 'not_found' };
  d.registry.setArchived(slug, false);
  return { ok: true };
}

export type DeleteOutcome = { ok: true } | { ok: false; code: 'not_found' | 'agent.notArchived' };

/**
 * Deletes an archived agent from the list (the user's clean-up of the archive): the record, the session, the terminal's scrollback and the
 * session token go. Its worktree, branch, ticket, report and ledger stay: they belong to the work, not to the list.
 */
export async function deleteArchived(d: { registry: AgentRegistry; forget(slug: string): Promise<void> }, slug: string): Promise<DeleteOutcome> {
  const a = d.registry.get(slug);
  if (!a) return { ok: false, code: 'not_found' };
  if (a.role === 'main' || !a.archived) return { ok: false, code: 'agent.notArchived' };
  await d.forget(slug);
  return { ok: true };
}

/** Deletes every archived agent ("Delete all" in the archive list). */
export async function deleteAllArchived(d: { registry: AgentRegistry; forget(slug: string): Promise<void> }): Promise<{ count: number; slugs: string[] }> {
  const slugs = d.registry.list().filter((a) => a.role !== 'main' && a.archived).map((a) => a.slug);
  for (const s of slugs) await d.forget(s);
  return { count: slugs.length, slugs };
}

/** Archives, in one go, every agent that `canArchive` allows right now (the "Archive all finished" button). Nothing is closed or deleted. */
export function archiveFinished(d: { registry: AgentRegistry; ticketStatus(slug: string): string | undefined }): { count: number; slugs: string[] } {
  const slugs = d.registry.list()
    .filter((a) => a.role !== 'main' && !a.archived && canArchive(a.state, d.ticketStatus(a.slug)))
    .map((a) => a.slug);
  for (const s of slugs) d.registry.setArchived(s, true);
  return { count: slugs.length, slugs };
}
