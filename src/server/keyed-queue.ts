import { AsyncLocalStorage } from 'node:async_hooks';

/** One stretch of work that holds a key. `done` becomes true when it ends, so a continuation that outlives it (a timer) is not mistaken for it. */
interface Frame { done: boolean }

/**
 * Runs the calls made for one key one after the other, so their effects never overlap and a later call sees what an earlier one persisted.
 * Re-entrant: a call made, in the same chain of awaits, from inside a call that holds the key runs at once (waiting for itself would
 * be a deadlock). The queue of a key removes itself when its work is over, so it never grows with the number of keys ever seen.
 */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly held = new AsyncLocalStorage<ReadonlyMap<string, Frame>>();

  /** How many keys have something queued or running (for tests). */
  get pending(): number { return this.tails.size; }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const heldNow = this.held.getStore();
    const mine = heldNow?.get(key);
    if (mine !== undefined && !mine.done) {
      try { return fn(); } catch (e) { return Promise.reject(e); } // a function that throws is a rejection, as on the queued path
    }
    const frame: Frame = { done: false };
    const context = new Map(heldNow ?? []);
    context.set(key, frame);
    const inner = (): Promise<T> => this.held.run(context, fn).finally(() => { frame.done = true; });
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(inner, inner);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return result;
  }

  /**
   * Kept for the callers that say "this key is gone". Nothing to do: a key with no work removes itself, and one with work running must
   * keep its order (dropping its chain would let the next call start in parallel with it).
   */
  forget(_key: string): void { /* intentionally empty */ }
}
