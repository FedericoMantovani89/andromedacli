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
