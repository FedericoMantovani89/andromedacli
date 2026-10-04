import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface GuardLogEntry {
  slug: string;
  role: 'main' | 'agent';
  tool: string;
  rule: string;
  reason: string;
  mode: 'enforce' | 'shadow';
  /** `denied`: the call was refused. `shadow-allowed`: it would have been refused, but the guard is in shadow mode. */
  outcome: 'denied' | 'shadow-allowed';
  /** The command or path that was judged, shortened. */
  detail: string;
}

const MAX_DETAIL = 300;

/** Appends what the guard refused (or would have refused) to `.console/state/guard.jsonl`. Never throws: logging must not fail a tool call. */
export class GuardLog {
  constructor(private readonly file: string) {}

  append(entry: GuardLogEntry): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry, detail: entry.detail.slice(0, MAX_DETAIL) })}\n`, 'utf8');
    } catch { /* a full disk or a locked file must not stop the agent's tool call */ }
  }
}
