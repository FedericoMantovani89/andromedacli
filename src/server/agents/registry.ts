import type { Activity, ModEvent } from '../../shared/activity';

export type Role = 'main' | 'agent' | 'reviewer' | 'recovery';

/** An agent's own worktree and branch (Phase 3) and the repository they belong to (absolute path; absent: the plan root). */
export interface AgentGit { worktree: string; branch: string; repo?: string }

export interface AgentRuntime {
  slug: string;
  role: Role;
  profile: string;
  goal?: string;
  state: Activity;
  sessionId?: string;
  /** The first goal was queued for this agent and no turn has completed since: it still counts as active (SPEC 16.7). */
  pendingGoal: boolean;
  lastEventAt?: string;
  /** The console ended this session on purpose: when its process exits the state is `finished`, not `interrupted`. */
  finishing?: boolean;
  /** The profile is read-only (a reviewer): the guard refuses anything that writes. */
  readOnly?: boolean;
  /** The agent's own worktree and branch (Phase 3); absent for the main and when `git.worktrees` is off. */
  git?: AgentGit;
  /** The folder the session runs in (from `session.start` or set by the console). */
  cwd?: string;
}

export interface RegisterInput {
  slug: string; role: Role; profile: string; goal?: string; queued?: boolean; readOnly?: boolean;
  /** The session to resume later, kept from an earlier registration (the main started again at a wake-up). */
  sessionId?: string;
}

/** State machine for every session, fed by mod events and process lifecycle. Illegal transitions are ignored. */
export class AgentRegistry {
  private readonly agents = new Map<string, AgentRuntime>();
  private readonly listeners: ((slug: string) => void)[] = [];

  on(cb: (slug: string) => void): void { this.listeners.push(cb); }

  register(a: RegisterInput): void {
    this.agents.set(a.slug, {
      slug: a.slug, role: a.role, profile: a.profile, goal: a.goal, readOnly: a.readOnly,
      state: a.queued ? 'queued' : 'starting', pendingGoal: Boolean(a.goal) && !a.queued,
      ...(a.sessionId !== undefined ? { sessionId: a.sessionId } : {}),
    });
    this.notify(a.slug);
  }

  /**
   * An agent restored after a console restart (Phase 6A): no process, no quota spent. `dormant` wakes on demand, `interrupted` lost its
   * turn (or its worktree), `finished` waits for its own flow (a suspended or blocked ticket). It never counts as active.
   */
  registerRestored(a: { slug: string; role: Role; profile: string; goal?: string; sessionId?: string; git?: AgentGit; cwd?: string; state: 'dormant' | 'interrupted' | 'finished' }): void {
    this.agents.set(a.slug, {
      slug: a.slug, role: a.role, profile: a.profile, goal: a.goal, state: a.state, pendingGoal: false,
      ...(a.sessionId !== undefined ? { sessionId: a.sessionId } : {}),
      ...(a.git ? { git: a.git } : {}),
      ...(a.cwd !== undefined ? { cwd: a.cwd } : {}),
    });
    this.notify(a.slug);
  }

  /** Shorthand for the common case of `registerRestored`. */
  registerDormant(a: { slug: string; role: Role; profile: string; goal?: string; sessionId?: string; git?: AgentGit; cwd?: string }): void {
    this.registerRestored({ ...a, state: 'dormant' });
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

  /**
   * A suspended session is resumed (`--resume`): same slug, worktree, session id and goal; it waits for a slot like a new launch.
   * The session id is kept so a resume that fails before the session reports in can be tried again.
   */
  revive(slug: string): void {
    const a = this.agents.get(slug);
    if (!a) return;
    a.finishing = false;
    a.pendingGoal = false;
    this.set(a, 'queued');
  }

  setGit(slug: string, git: AgentGit | undefined): void {
    const a = this.agents.get(slug);
    if (a) a.git = git;
  }

  setCwd(slug: string, cwd: string): void {
    const a = this.agents.get(slug);
    if (a) a.cwd = cwd;
  }

  /** The session is about to be ended on purpose (a merged ticket, a finished review). */
  markFinished(slug: string): void {
    const a = this.agents.get(slug);
    if (a) a.finishing = true;
  }

  goalDelivered(slug: string): void {
    const a = this.agents.get(slug);
    if (a) a.pendingGoal = false;
  }

  onModEvent(slug: string, e: ModEvent): void {
    const a = this.agents.get(slug);
    if (!a || a.state === 'interrupted' || a.state === 'finished') return;
    a.lastEventAt = new Date().toISOString();
    switch (e.type) {
      case 'session.start':
        a.sessionId = e.sessionId;
        if (typeof e.data?.cwd === 'string') a.cwd = e.data.cwd;
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
    if (!a || a.state === 'interrupted' || a.state === 'finished') return;
    if (waiting) this.set(a, 'waiting_user');
    else if (a.state === 'waiting_user') this.set(a, 'working');
  }

  onProcessExit(slug: string): void {
    const a = this.agents.get(slug);
    if (a) { a.pendingGoal = false; this.set(a, a.finishing ? 'finished' : 'interrupted'); }
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
