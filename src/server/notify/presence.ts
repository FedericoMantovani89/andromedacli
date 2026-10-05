import type { PresenceReport } from '../../shared/notify';

/** A report older than this counts as "no console in front" (closed tab, sleeping machine). The UI sends one every 15 s. */
export const PRESENCE_TTL_MS = 40_000;

/** Validates the body of POST /api/presence; undefined when it is not a report. */
export function parsePresence(body: unknown): PresenceReport | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.focused !== 'boolean' || typeof b.visible !== 'boolean' || typeof b.drawerOpen !== 'boolean' || typeof b.active !== 'string') return undefined;
  return { focused: b.focused, visible: b.visible, drawerOpen: b.drawerOpen, active: b.active.slice(0, 64) };
}

/** What the user is looking at, as the UI last said (SPEC 20.3). */
export class Presence {
  private last: { report: PresenceReport; at: number } | undefined;

  constructor(private readonly now: () => number = () => Date.now()) {}

  report(r: PresenceReport): void { this.last = { report: r, at: this.now() }; }

  private fresh(): PresenceReport | undefined {
    return this.last && this.now() - this.last.at <= PRESENCE_TTL_MS ? this.last.report : undefined;
  }

  /** A queue item from `from` need not be announced: the console is in front and shows the queue or that session. */
  suppressesItem(from: string): boolean {
    const r = this.fresh();
    return r !== undefined && r.focused && r.visible && (r.drawerOpen || r.active === from);
  }

  /** An interrupted agent: only when its own panel is the active one in a focused, visible console. */
  suppressesAgent(slug: string): boolean {
    const r = this.fresh();
    return r !== undefined && r.focused && r.visible && r.active === slug;
  }
}
