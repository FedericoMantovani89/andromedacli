export type Verdict = 'allow' | 'deny';

/**
 * "Always allow / deny" for tool permissions (SPEC 32.3): one agent, the exact same tool and key (the whole input as the mod saw it),
 * until its process ends. Memory only. A blank key is never remembered (it would stand for every call of the tool).
 */
export class PermissionMemory {
  private readonly bySlug = new Map<string, Map<string, Verdict>>();
  /** Queue items that wait for an answer, so an "always" can answer the identical ones already waiting. */
  private readonly asked = new Map<string, { slug: string; tool: string; key: string }>();

  private mapKey(tool: string, key: string): string { return JSON.stringify([tool, key]); }

  recall(slug: string, tool: string, key: string): Verdict | undefined {
    return this.bySlug.get(slug)?.get(this.mapKey(tool, key));
  }

  remember(slug: string, tool: string, key: string, verdict: Verdict): void {
    if (key.trim() === '') return;
    const m = this.bySlug.get(slug) ?? new Map<string, Verdict>();
    m.set(this.mapKey(tool, key), verdict);
    this.bySlug.set(slug, m);
  }

  track(id: string, slug: string, tool: string, key: string): void {
    if (key.trim() !== '') this.asked.set(id, { slug, tool, key });
  }

  untrack(id: string): void { this.asked.delete(id); }

  /** Ids of the other waiting items of the same agent for the same tool and key. */
  siblings(slug: string, tool: string, key: string, exceptId: string): string[] {
    return [...this.asked].filter(([id, a]) => id !== exceptId && a.slug === slug && a.tool === tool && a.key === key).map(([id]) => id);
  }

  forget(slug: string): void {
    this.bySlug.delete(slug);
    for (const [id, a] of this.asked) if (a.slug === slug) this.asked.delete(id);
  }
}
