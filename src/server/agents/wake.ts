import type { AgentRegistry } from './registry';
import { SESSION_ID_RE } from '../pty/claude-launch';

export type WakeReason = 'user' | 'work' | 'main';

/** Codes are also error codes of the HTTP route (`error.<code>` texts exist for each). */
export type WakeCode = 'agent.notDormant' | 'agent.noSession' | 'agent.noWorktree' | 'agent.quotaHigh' | 'agent.wakeFailed';

export type WakeOutcome = { ok: true; status: 'started' | 'queued' } | { ok: false; code: WakeCode };

export interface WakeDeps {
  registry: AgentRegistry;
  /** `launchResume` with the reason: the normal flow, so the scheduler's limits and queue apply. */
  launch(slug: string, sessionId: string, reason: WakeReason): Promise<{ ok: true } | { ok: false; code: string }>;
  /** The agent's worktree is on disk (always true with worktrees off). */
  hasWorktree(slug: string): boolean;
  /** The subscription quota is at or above the freeze threshold: nothing wakes. */
  quotaHigh(): boolean;
  changed(): void;
}

/**
 * Wakes a dormant agent with `claude --resume` (SPEC 19.3). Three triggers: the user opens it, work arrives for it, or the main asks.
 * The guard rails are the ones of any resumed session: the quota must not be frozen, the worktree must exist, and the scheduler
 * decides between starting now and waiting for a slot. An interrupted agent is woken only on the main's request or the user's.
 */
export class WakeService {
  /** Names being woken: a second trigger while the first is in flight does nothing. */
  private readonly waking = new Set<string>();

  constructor(private readonly d: WakeDeps) {}

  async wake(slug: string, reason: WakeReason): Promise<WakeOutcome> {
    const a = this.d.registry.get(slug);
    if (!a || a.role !== 'agent') return { ok: false, code: 'agent.notDormant' };
    // Work that arrives wakes only a dormant agent: an agent that died during this run is not restarted behind the main's back.
    const wakeable = a.state === 'dormant' || (a.state === 'interrupted' && reason !== 'work');
    if (!wakeable || this.waking.has(slug)) return { ok: false, code: 'agent.notDormant' };
    if (!a.sessionId || !SESSION_ID_RE.test(a.sessionId)) return { ok: false, code: 'agent.noSession' };
    if (!this.d.hasWorktree(slug)) return { ok: false, code: 'agent.noWorktree' };
    if (this.d.quotaHigh()) return { ok: false, code: 'agent.quotaHigh' };
    this.waking.add(slug);
    try {
      const r = await this.d.launch(slug, a.sessionId, reason);
      if (!r.ok) return { ok: false, code: r.code === 'no_worktree' ? 'agent.noWorktree' : r.code === 'no_session' ? 'agent.noSession' : 'agent.wakeFailed' };
      return { ok: true, status: this.d.registry.get(slug)?.state === 'queued' ? 'queued' : 'started' };
    } catch {
      return { ok: false, code: 'agent.wakeFailed' };
    } finally {
      this.waking.delete(slug);
      this.d.changed();
    }
  }

  /** Work arrived for `slug` (an inbox push): wakes it when it is dormant. Never throws; the message stays in the inbox either way. */
  onWork(slug: string): void {
    if (this.d.registry.get(slug)?.state !== 'dormant') return;
    void this.wake(slug, 'work').catch(() => undefined);
  }
}
