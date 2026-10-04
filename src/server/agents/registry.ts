import type { Activity, ModEvent } from '../../shared/activity';

export interface AgentRuntime {
  slug: string;
  role: 'main' | 'agent';
  profile: string;
  goal?: string;
  state: Activity;
  sessionId?: string;
  /** The first goal was queued for this agent and no turn has completed since: it still counts as active (SPEC 16.7). */
  pendingGoal: boolean;
  lastEventAt?: string;
  /** The agent's own worktree and branch (Phase 3); absent for the main and when `git.worktrees` is off. */
  git?: { worktree: string; branch: string };
}

export interface RegisterInput {
  slug: string; role: 'main' | 'agent'; profile: string; goal?: string; queued?: boolean;
}

/** State machine for every session, fed by mod events and process lifecycle. Illegal transitions are ignored. */
export class AgentRegistry {
  private readonly agents = new Map<string, AgentRuntime>();
  private readonly listeners: ((slug: string) => void)[] = [];

  on(cb: (slug: string) => void): void { this.listeners.push(cb); }

  register(a: RegisterInput): void {
    this.agents.set(a.slug, {
      slug: a.slug, role: a.role, profile: a.profile, goal: a.goal,
      state: a.queued ? 'queued' : 'starting', pendingGoal: Boolean(a.goal) && !a.queued,
    });
    this.notify(a.slug);
  }

  get(slug: string): AgentRuntime | undefined { return this.agents.get(slug); }

  /** Forgets a session whose creation failed. */
  remove(slug: string): void {
    if (this.agents.delete(slug)) this.notify(slug);
  }

  list(): AgentRuntime[] { return [...this.agents.values()]; }

  /** The process now exists (a queued agent got its slot, or a new one started). */
  onSpawned(slug: string): void {
    const a = this.agents.get(slug);
    if (!a) return;
    a.pendingGoal = Boolean(a.goal);
    this.set(a, 'starting');
  }

  setGit(slug: string, git: { worktree: string; branch: string } | undefined): void {
    const a = this.agents.get(slug);
    if (a) a.git = git;
  }

  goalDelivered(slug: string): void {
    const a = this.agents.get(slug);
    if (a) a.pendingGoal = false;
  }

  onModEvent(slug: string, e: ModEvent): void {
    const a = this.agents.get(slug);
    if (!a || a.state === 'interrupted') return;
    a.lastEventAt = new Date().toISOString();
    switch (e.type) {
      case 'session.start':
        a.sessionId = e.sessionId;
        if (a.state === 'starting') this.set(a, 'idle');
        break;
      case 'turn.start':
        this.set(a, 'working');
        break;
      case 'turn.complete':
        a.pendingGoal = false;
        if (a.state !== 'waiting_user') this.set(a, 'idle');
        break;
      case 'session.end':
        break; // the process exit decides (onProcessExit)
    }
  }

  setWaitingUser(slug: string, waiting: boolean): void {
    const a = this.agents.get(slug);
    if (!a || a.state === 'interrupted') return;
    if (waiting) this.set(a, 'waiting_user');
    else if (a.state === 'waiting_user') this.set(a, 'working');
  }

  onProcessExit(slug: string): void {
    const a = this.agents.get(slug);
    if (a) { a.pendingGoal = false; this.set(a, 'interrupted'); }
  }

  /** SPEC 16.7: active = starting, working, or idle with the first goal still pending. Main and everything else: no. */
  isActive(slug: string): boolean {
    const a = this.agents.get(slug);
    if (!a || a.role === 'main') return false;
    return a.state === 'starting' || a.state === 'working' || (a.state === 'idle' && a.pendingGoal);
  }

  private set(a: AgentRuntime, state: Activity): void {
    if (a.state === state) return;
    a.state = state;
    this.notify(a.slug);
  }

  private notify(slug: string): void {
    for (const cb of this.listeners) cb(slug);
  }
}
