export type Verdict = 'allow' | 'deny';

/**
 * "Always allow / deny" for tool permissions (SPEC 32.3): one agent, the exact same tool and detail, until its process ends.
 * Memory only. An empty detail is never remembered (its key would stand for every call of the tool).
 */
export class PermissionMemory {
  private readonly bySlug = new Map<string, Map<string, Verdict>>();

  private key(tool: string, detail: string): string { return JSON.stringify([tool, detail]); }

  recall(slug: string, tool: string, detail: string): Verdict | undefined {
    return this.bySlug.get(slug)?.get(this.key(tool, detail));
  }

  remember(slug: string, tool: string, detail: string, verdict: Verdict): void {
    if (detail === '') return;
    const m = this.bySlug.get(slug) ?? new Map<string, Verdict>();
    m.set(this.key(tool, detail), verdict);
    this.bySlug.set(slug, m);
  }

  forget(slug: string): void { this.bySlug.delete(slug); }
}
