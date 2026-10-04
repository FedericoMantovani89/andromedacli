import type { AgentRegistry } from './registry';

export interface SpawnRequest {
  slug: string;
  profile: string;
  goal?: string;
  model?: string;
  source: 'main' | 'user';
}

/** `ready` is present when the start is asynchronous (it creates a worktree first): it rejects if the start fails. */
export type RequestResult = { status: 'started'; ready?: Promise<void> } | { status: 'queued'; position: number };

export interface SchedulerOptions {
  registry: AgentRegistry;
  /** Read on every decision, so changing the limits takes effect without restarting anything (SPEC 16.7, 22.2). */
  limits: () => { global: number; perPlan: number };
  /**
   * Actually starts the process. May throw, or return a promise that rejects. Either way the agent must count as active from the
   * synchronous part of the call (the registry state), so the next decision sees the slot as taken.
   */
  start: (r: SpawnRequest) => void | Promise<void>;
  /** A queued request whose start failed (it is dropped; the queue goes on). */
  onStartError?: (r: SpawnRequest, error: unknown) => void;
}

/**
 * Limit on active agents (SPEC 16.7). Over the limit a request does not fail: it waits in order and starts by itself when
 * a slot frees. Lowering the limit never stops a running agent; it only delays new ones.
 */
export class Scheduler {
  private readonly waiting: SpawnRequest[] = [];
  private closed = false;

  constructor(private readonly o: SchedulerOptions) {
    // Every state change may free a slot (an agent went idle, waits for the user, or its process died).
    o.registry.on(() => this.release());
  }

  /** Shutdown: processes dying must not make the queue start new ones. */
  close(): void {
    this.closed = true;
    this.waiting.length = 0;
  }

  request(r: SpawnRequest): RequestResult {
    if (this.closed) throw new Error('the console is closing');
    if (this.waiting.length === 0 && this.hasRoom()) {
      const started = this.o.start(r); // an error here belongs to the caller (nothing was queued)
      return started instanceof Promise ? { status: 'started', ready: started } : { status: 'started' };
    }
    this.waiting.push(r);
    return { status: 'queued', position: this.waiting.length };
  }

  /** Starts as many queued requests, oldest first, as there is room for. Safe to call at any time and repeatedly. */
  release(): void {
    while (!this.closed && this.waiting.length > 0 && this.hasRoom()) {
      const next = this.waiting.shift()!;
      try {
        const started = this.o.start(next);
        if (started instanceof Promise) started.catch((error: unknown) => this.o.onStartError?.(next, error));
      } catch (error) {
        this.o.onStartError?.(next, error);
      }
    }
  }

  queued(): SpawnRequest[] { return [...this.waiting]; }

  position(slug: string): number | undefined {
    const i = this.waiting.findIndex((r) => r.slug === slug);
    return i < 0 ? undefined : i + 1;
  }

  cancel(slug: string): void {
    const i = this.waiting.findIndex((r) => r.slug === slug);
    if (i >= 0) this.waiting.splice(i, 1);
  }

  private hasRoom(): boolean {
    const { global, perPlan } = this.o.limits();
    const active = this.o.registry.list().filter((a) => this.o.registry.isActive(a.slug)).length;
    return active < Math.min(global, perPlan);
  }
}
