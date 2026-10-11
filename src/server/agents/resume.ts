import type { BudgetConfig } from '../config';
import type { TicketStore } from '../tickets/store';
import type { AgentRegistry } from './registry';
import { SESSION_ID_RE } from '../pty/claude-launch';
import { errorMessage } from '../../shared/guards';
import { MainTeller } from '../main-teller';

export interface ResumeDeps {
  tickets: TicketStore;
  registry: AgentRegistry;
  config: () => BudgetConfig['quota'];
  quotaWorst(): { percent: number } | undefined;
  clock: { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
  /** Starts `claude --resume` in the agent's worktree through the normal flow (the scheduler's limits apply). */
  launch(slug: string, sessionId: string): Promise<{ ok: true } | { ok: false; code: string }>;
  /** Tickets waiting in `suspended_limit`. */
  suspendedTickets(): string[];
  /** The agent's worktree is still on disk (a resume needs it: nothing new is created). */
  hasWorktree(slug: string): boolean;
  /** Phase 6A: the agent is dormant or interrupted (restored after a console restart): the main wakes it with the same tool. */
  wakeable?(slug: string): boolean;
  /** Wakes a wakeable agent (no ticket change: its ticket is where it was). */
  wake?(slug: string, sessionId: string): Promise<{ ok: true } | { ok: false; code: string }>;
  /** A start that failed after the tool already answered (a later group, or the launch itself) is told to the main. */
  tellMain(text: string): void;
  changed(): void;
}

export type ResumeResult =
  | { status: 'ok'; started: string[]; scheduled: { name: string; inSeconds: number }[] }
  | { status: 'refused'; code: 'quota_high' | 'not_suspended' | 'no_session' | 'no_worktree'; detail?: string };

export type WakeResult = 'running' | 'limited';

/**
 * Tool `resume_agent` (SPEC 18.4): only the main decides what to resume after a usage limit, and the console decides how fast.
 * Every name must be a ticket suspended for the limit, with a session to resume and its worktree; nothing starts while the quota is at
 * or above the freeze threshold (an over-eager main cannot burn the new window); the rest starts in groups with a fixed pause.
 * Only `suspended_limit` is accepted: a budget stop goes through recovery or the user's decision, never through a resumed session.
 */
export class ResumeService {
  /** Names already given to a later group: asking again before it starts is refused. */
  private readonly pending = new Set<string>();
  /** Groups waiting for their turn (cleared at shutdown). */
  private readonly timers = new Set<unknown>();
  /** When the next group may start, across calls (the staggering is not per call). */
  private nextFreeAt = 0;

  constructor(private readonly d: ResumeDeps) {}

  resume(names: string[]): ResumeResult {
    const unique = [...new Set(names)];
    const q = this.d.config();
    const worst = this.d.quotaWorst();
    if (worst !== undefined && worst.percent >= q.freezePercent) {
      return { status: 'refused', code: 'quota_high', detail: `usage at ${Math.round(worst.percent)}%, resume refused at ${q.freezePercent}% or more` };
    }
    // Everything is checked before anything starts: one wrong name refuses the whole call.
    const suspended = new Set(this.d.suspendedTickets());
    const sessions = new Map<string, string>();
    for (const name of unique) {
      if (!suspended.has(name) && !this.isWakeable(name)) return { status: 'refused', code: 'not_suspended', detail: name };
      if (this.pending.has(name)) return { status: 'refused', code: 'not_suspended', detail: `${name} is already being resumed` };
      const sessionId = this.d.registry.get(name)?.sessionId;
      // Without a session to resume the ticket needs a recovery, not a resume.
      if (!sessionId || !SESSION_ID_RE.test(sessionId)) return { status: 'refused', code: 'no_session', detail: name };
      if (!this.d.hasWorktree(name)) return { status: 'refused', code: 'no_worktree', detail: name };
      sessions.set(name, sessionId);
    }
    const group = Math.max(1, Math.floor(q.staggerGroup));
    const stagger = Math.max(0, q.staggerSeconds) * 1000;
    // The pause holds across calls: a second call right after the first waits for the slot after the first call's last group.
    const now = this.d.clock.now();
    const base = Math.max(now, this.nextFreeAt);
    const started: string[] = [];
    const scheduled: { name: string; inSeconds: number }[] = [];
    let last = this.nextFreeAt;
    for (let i = 0, n = 0; i < unique.length; i += group, n += 1) {
      const batch = unique.slice(i, i + group);
      const at = base + n * stagger;
      last = at;
      if (at <= now) {
        for (const name of batch) { this.start(name, sessions.get(name)!); started.push(name); }
        continue;
      }
      const inSeconds = Math.round((at - now) / 1000);
      for (const name of batch) {
        this.pending.add(name);
        scheduled.push({ name, inSeconds });
      }
      const timer = this.d.clock.setTimeout(() => {
        this.timers.delete(timer);
        for (const name of batch) this.pending.delete(name);
        // The thresholds are checked again when the group's turn comes: a quota that rose meanwhile keeps it suspended.
        const w = this.d.quotaWorst();
        const limit = this.d.config().freezePercent;
        if (w !== undefined && w.percent >= limit) {
          this.main.tell(`Resuming ${batch.map((b) => `"${b}"`).join(', ')} was put off: the usage is at ${Math.round(w.percent)}% (resume is refused at ${limit}% or more), so the tickets stay suspended. Call resume_agent again when it is lower.`);
          this.safeChanged();
          return;
        }
        for (const name of batch) this.start(name, sessions.get(name)!);
        this.safeChanged();
      }, at - now);
      this.timers.add(timer);
    }
    this.nextFreeAt = last + stagger;
    this.safeChanged();
    return { status: 'ok', started, scheduled };
  }

  /** Shutdown: no group starts after the console closed. */
  close(): void {
    for (const t of this.timers) this.d.clock.clearTimeout(t);
    this.timers.clear();
    this.pending.clear();
  }

  /** Back to `in_progress` first, then the launch; a launch that fails puts the ticket back where it was and tells the main. */
  private isWakeable(name: string): boolean { return this.d.wakeable?.(name) === true && this.d.wake !== undefined; }

  /** A dormant or interrupted agent (Phase 6A): the session resumes as it is; no ticket changes, and a failure only tells the main. */
  private startWake(name: string, sessionId: string): void {
    let run: Promise<{ ok: true } | { ok: false; code: string }>;
    try { run = this.d.wake!(name, sessionId); } catch (err) { run = Promise.reject(err); }
    void run.then(
      (r) => { if (!r.ok) this.main.tell(`Waking "${name}" failed (${r.code}); it stays as it was.`); },
      (err: unknown) => this.main.tell(`Waking "${name}" failed (${errorMessage(err)}); it stays as it was.`),
    ).finally(() => this.safeChanged());
  }

  private start(name: string, sessionId: string): void {
    if (this.isWakeable(name)) { this.startWake(name, sessionId); return; }
    try {
      this.d.tickets.restart(name);
    } catch (err) {
      this.main.tell(`Resuming "${name}" did not start: its ticket is no longer suspended for the usage limit (${errorMessage(err)}).`);
      return;
    }
    let run: Promise<{ ok: true } | { ok: false; code: string }>;
    try { run = this.d.launch(name, sessionId); } catch (err) { run = Promise.reject(err); }
    void run.then(
      (r) => { if (!r.ok) this.failed(name, r.code); },
      (err: unknown) => this.failed(name, errorMessage(err)),
    );
  }

  private failed(name: string, code: string): void {
    try {
      if (this.d.tickets.get(name)?.status === 'in_progress') this.d.tickets.move(name, 'suspended_limit');
    } catch { /* the message below still goes */ }
    this.main.tell(`Resuming "${name}" failed (${code}); its ticket is suspended again.`);
    this.safeChanged();
  }

  private readonly main = new MainTeller((text) => this.d.tellMain(text));

  private safeChanged(): void {
    try { this.d.changed(); } catch { /* the UI push must not break a resume */ }
  }
}
