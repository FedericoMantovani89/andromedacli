import type { AgentRegistry, AgentRuntime } from './registry';

export interface LaunchWatchOptions {
  registry: AgentRegistry;
  /** Read when a check is scheduled. */
  delayMs: () => number;
  /** Tells the main session (its inbox); the mod delivers it as a new turn. */
  notifyMain: (text: string) => void;
}

type Problem = 'no_session' | 'goal_not_taken' | 'ended';

function problemOf(a: AgentRuntime): Problem | undefined {
  if (a.state === 'interrupted') return 'ended';
  if (a.state === 'starting') return 'no_session';
  if (a.state === 'idle' && a.pendingGoal) return 'goal_not_taken';
  return undefined;
}

/**
 * After an agent is launched, checks once (default 90 s later) that it reported in and took its goal; if not, the main is told
 * with the reason (a trust dialog or a crash is the usual cause). The check is the console's, not the main's: a model cannot wait,
 * and agents started from the UI button have no one else watching. A stalled agent is also flagged for the panel until it works.
 */
export class LaunchWatch {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reported = new Set<string>();

  constructor(private readonly o: LaunchWatchOptions) {}

  watch(slug: string): void {
    if (!this.o.registry.get(slug)) return;
    const delay = this.o.delayMs();
    clearTimeout(this.timers.get(slug));
    this.reported.delete(slug);
    const timer = setTimeout(() => this.check(slug, delay), delay);
    timer.unref?.();
    this.timers.set(slug, timer);
  }

  /** True from the report until the agent starts working (or ends). */
  stalled(slug: string): boolean {
    const a = this.o.registry.get(slug);
    if (!a || !this.reported.has(slug)) return false;
    const p = problemOf(a);
    return p === 'no_session' || p === 'goal_not_taken';
  }

  close(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private check(slug: string, delay: number): void {
    this.timers.delete(slug);
    const a = this.o.registry.get(slug);
    if (!a) return;
    const problem = problemOf(a);
    if (!problem) return;
    this.reported.add(slug);
    const seconds = Math.round(delay / 1000);
    const what = problem === 'no_session'
      ? `has not started: ${seconds} seconds after launch its Claude Code never reported in`
      : problem === 'goal_not_taken'
        ? `is running but has not taken its goal ${seconds} seconds after launch`
        : `ended before it started working (${seconds} seconds after launch)`;
    this.o.notifyMain(`Launch check: agent "${slug}" ${what}. Look at it with list_agents; a dialog waiting in its terminal is the usual cause. Tell the user instead of waiting.`);
  }
}
