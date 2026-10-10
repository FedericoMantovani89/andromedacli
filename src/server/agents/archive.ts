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

/** Archives, in one go, every agent that `canArchive` allows right now (the "Archive all finished" button). Nothing is closed or deleted. */
export function archiveFinished(d: { registry: AgentRegistry; ticketStatus(slug: string): string | undefined }): { count: number; slugs: string[] } {
  const slugs = d.registry.list()
    .filter((a) => a.role !== 'main' && !a.archived && canArchive(a.state, d.ticketStatus(a.slug)))
    .map((a) => a.slug);
  for (const s of slugs) d.registry.setArchived(s, true);
  return { count: slugs.length, slugs };
}
