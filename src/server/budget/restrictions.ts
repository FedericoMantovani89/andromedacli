import type { GuardContext } from '../guard/rules';

export type Restriction = NonNullable<GuardContext['restricted']>;

/** budget > limit > loop: a stronger restriction is never replaced by a weaker one. */
const RANK: Record<Restriction['reason'], number> = { loop: 1, limit: 2, budget: 3 };

/** The restriction the console holds on each session (SPEC 16, 17, 18); the guard reads it on every call. Cleared when the process ends. */
export class Restrictions {
  private readonly bySlug = new Map<string, Restriction>();

  set(slug: string, r: Restriction): void {
    const current = this.bySlug.get(slug);
    if (current && RANK[current.reason] > RANK[r.reason]) return;
    this.bySlug.set(slug, r);
  }

  get(slug: string): Restriction | undefined { return this.bySlug.get(slug); }

  clear(slug: string): void { this.bySlug.delete(slug); }
}
