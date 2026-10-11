/** Tells the main about a problem of a background service; telling must never throw (nothing more can be done if it fails). */
export class MainTeller {
  private readonly told = new Set<string>();

  constructor(private readonly tellMain: (text: string) => void) {}

  tell(text: string): void {
    try { this.tellMain(text); } catch { /* nothing more can be done */ }
  }

  /** Tells once per key (the same failure is not repeated for the same agent); `reset` lets the key be told again. */
  once(key: string, text: string): void {
    if (this.told.has(key)) return;
    this.told.add(key);
    this.tell(text);
  }

  reset(key: string): void { this.told.delete(key); }
}
