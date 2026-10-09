import { writeJsonAtomic } from './fs-atomic';
import { HELPER_IDS, helpersUsedIn, type HelperId } from './helper-tools';
import { readJsonFile } from './json-file';

/** What the Prerequisites tab shows: how many shell commands used each helper since the count started. Only command names are kept, never a command. */
export interface HelperUse { since: string; counts: Partial<Record<HelperId, number>> }

/**
 * A console-wide count of the shell commands (of the main and of every agent, in every project) that used each optional helper. It answers
 * "do they actually use what I installed?". The text of a command is never stored, only one counter per helper.
 */
export class HelperUsage {
  private data: HelperUse;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly file: string, private readonly now: () => Date = () => new Date()) {
    this.data = this.load();
  }

  private load(): HelperUse {
    const parsed = readJsonFile(this.file) as Partial<HelperUse> | undefined; // missing or damaged: the count starts again
    if (parsed && typeof parsed.since === 'string' && typeof parsed.counts === 'object' && parsed.counts !== null) {
      const counts: HelperUse['counts'] = {};
      for (const id of HELPER_IDS) { const n = (parsed.counts as Record<string, unknown>)[id]; if (typeof n === 'number' && n >= 0) counts[id] = n; }
      return { since: parsed.since, counts };
    }
    return { since: this.now().toISOString(), counts: {} };
  }

  /** Counts the helpers a shell command line uses (once each per line). */
  record(command: string): void {
    const used = helpersUsedIn(command);
    if (used.length === 0) return;
    for (const id of used) this.data.counts[id] = (this.data.counts[id] ?? 0) + 1;
    this.schedule();
  }

  state(): HelperUse {
    return { since: this.data.since, counts: { ...this.data.counts } };
  }

  /** Written a moment after the last use, not on every command. */
  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 2000);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    try { writeJsonAtomic(this.file, this.data); } catch { /* the count is a convenience, not a requirement */ }
  }
}
