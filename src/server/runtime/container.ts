/**
 * A per-project registry of services. A factory runs the first time its key is asked for, and its result is kept: every `get` of a
 * key gives the same object. A factory that (through other factories) needs its own key is a cycle: it throws with the chain of keys.
 * A dependency that is circular by nature is read inside a lambda, at call time, which the container never sees as a cycle.
 */
export type Factory<S extends object, K extends keyof S> = (c: Container<S>) => S[K];

export class Container<S extends object> {
  private readonly factories = new Map<keyof S, Factory<S, keyof S>>();
  private readonly values = new Map<keyof S, unknown>();
  private readonly resolving: (keyof S)[] = [];

  /** `onCreate` hears each service as it is created (the creation order; used by tests and diagnostics). */
  constructor(private readonly o: { onCreate?: (key: keyof S) => void } = {}) {}

  provide<K extends keyof S>(key: K, factory: Factory<S, K>): void {
    if (this.factories.has(key)) throw new Error(`already provided: "${String(key)}"`);
    this.factories.set(key, factory as Factory<S, keyof S>);
  }

  /** Replaces a provider (a test puts a fake); refused once the service exists. */
  override<K extends keyof S>(key: K, factory: Factory<S, K>): void {
    if (this.values.has(key)) throw new Error(`cannot override "${String(key)}": it was already created`);
    this.factories.set(key, factory as Factory<S, keyof S>);
  }

  has(key: keyof S): boolean { return this.factories.has(key); }

  get<K extends keyof S>(key: K): S[K] {
    if (this.values.has(key)) return this.values.get(key) as S[K];
    const factory = this.factories.get(key);
    if (!factory) throw new Error(`no provider for "${String(key)}"`);
    if (this.resolving.includes(key)) throw new Error(`container cycle: ${[...this.resolving, key].map(String).join(' -> ')}`);
    this.resolving.push(key);
    try {
      const value = factory(this) as S[K];
      this.values.set(key, value);
      this.o.onCreate?.(key);
      return value;
    } finally {
      this.resolving.pop();
    }
  }
}

/** Creates the listed services in that order: the order in which today's code creates them, so their effects keep that order. */
export function boot<S extends object>(c: Container<S>, order: readonly (keyof S)[]): void {
  for (const key of order) c.get(key);
}
