/** Runs the calls made for one key one after the other, so their effects never overlap and a later call sees what an earlier one persisted. */
export class KeyedQueue {
  private readonly chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(key) ?? Promise.resolve()).then(fn, fn);
    this.chains.set(key, run.catch(() => undefined));
    return run;
  }

  /** Forgets the key's chain (the agent is gone); a call still running finishes. */
  forget(key: string): void { this.chains.delete(key); }
}
