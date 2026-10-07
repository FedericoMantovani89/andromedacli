import { randomUUID } from 'node:crypto';

export interface Question {
  id: string;
  from: string;
  /**
   * `permission`: an agent's tool wants approval ("allow" / "deny"). `confirm`: the console asks the user to approve something
   * ("approve" / "reject"). `decision`: the console asks the user to choose among its own option codes. The last two come from
   * the console itself (from "console") and run a handler when answered.
   */
  kind: 'question' | 'permission' | 'confirm' | 'decision';
  text: string;
  options?: string[];
  multiSelect?: boolean;
  /** Permission requests: the tool and what it would do (a command, a file path). */
  tool?: string;
  detail?: string;
  /** Plain data the UI shows for console items (tickets, reports, notes). */
  payload?: unknown;
  createdAt: string;
}

export interface WaitResult { answered: boolean; answer?: string; gone?: boolean }

const ANSWERED_KEEP_MS = 60 * 60 * 1000; // an answer stays readable for a late long-poll
const MAX_TEXT = 4000;
/** The asker of console items. It is not a valid slug, so no agent or project can ever be called that: no turn or exit of any session drops them. */
export const CONSOLE_FROM = '@console';
const MAX_PAYLOAD = 100_000; // characters of JSON: a report is text, but the drawer must never choke on one

/**
 * Questions for the human (SPEC 5.6). The asker waits with short long-polls; the human answers from the UI. An answer is
 * kept for a while so a poll that arrives just after it still gets it; a question whose asker died is dropped.
 */
export class QuestionQueue {
  private readonly open = new Map<string, Question>();
  private readonly answered = new Map<string, { from: string; answer: string; at: number }>();
  private readonly waiters = new Map<string, ((r: WaitResult) => void)[]>();
  private readonly listeners: (() => void)[] = [];
  private readonly handlers = new Map<string, (answer: string) => void>();

  private readonly addListeners: ((q: Question) => void)[] = [];

  onChange(cb: () => void): void { this.listeners.push(cb); }

  /** Called with every new item (notifications); a throwing listener never breaks the queue. */
  onAdd(cb: (q: Question) => void): void { this.addListeners.push(cb); }

  ask(
    q: { from: string; text: string; options?: string[]; multiSelect?: boolean; kind?: Question['kind']; tool?: string; detail?: string; payload?: unknown },
    onAnswer?: (answer: string) => void,
  ): { id: string } {
    this.forgetOldAnswers();
    const id = randomUUID();
    const kind = q.kind ?? 'question';
    const permission = kind === 'permission';
    const confirm = kind === 'confirm';
    this.open.set(id, {
      id, from: q.from, kind, text: q.text.slice(0, MAX_TEXT),
      options: permission ? ['allow', 'deny'] : confirm ? ['approve', 'reject'] : q.options,
      multiSelect: permission || confirm || kind === 'decision' ? false : q.multiSelect,
      ...(permission ? { tool: (q.tool ?? '').slice(0, 100), detail: (q.detail ?? '').slice(0, 4000) } : {}),
      ...(q.payload !== undefined ? { payload: boundedPayload(q.payload) } : {}),
      createdAt: new Date().toISOString(),
    });
    if (onAnswer) this.handlers.set(id, onAnswer);
    this.changed();
    const added = this.open.get(id)!;
    for (const cb of this.addListeners) { try { cb(added); } catch { /* a listener must not break the queue */ } }
    return { id };
  }

  answer(id: string, answer: string): 'ok' | 'unknown' | 'already' | 'invalid' {
    if (this.answered.has(id)) return 'already';
    const q = this.open.get(id);
    if (!q) return 'unknown';
    const text = answer.trim();
    if (text === '') return 'invalid';
    if (q.kind !== 'question' && q.options && !q.options.includes(text)) return 'invalid'; // permissions, confirmations and decisions only know their own answers
    this.open.delete(id);
    this.answered.set(id, { from: q.from, answer: text, at: Date.now() });
    this.resolve(id, { answered: true, answer: text });
    const handler = this.handlers.get(id);
    this.handlers.delete(id);
    try { handler?.(text); } catch { /* the answer stands; a failing handler must not undo it */ }
    this.changed();
    return 'ok';
  }

  /** Resolves when answered, when the question is gone, or after `ms` with answered:false (the question stays). */
  wait(id: string, ms: number, from?: string): Promise<WaitResult> {
    const done = this.answered.get(id);
    if (done && (from === undefined || done.from === from)) return Promise.resolve({ answered: true, answer: done.answer });
    const q = this.open.get(id);
    if (!q || (from !== undefined && q.from !== from)) return Promise.resolve({ answered: false, gone: true });
    return new Promise((resolve) => {
      const list = this.waiters.get(id) ?? [];
      let settled = false;
      const settle = (r: WaitResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
      const timer = setTimeout(() => {
        const rest = (this.waiters.get(id) ?? []).filter((w) => w !== settle);
        if (rest.length) this.waiters.set(id, rest); else this.waiters.delete(id);
        settle({ answered: false });
      }, ms);
      list.push(settle);
      this.waiters.set(id, list);
    });
  }

  pending(): Question[] { return [...this.open.values()]; }

  hasPending(from: string): boolean {
    for (const q of this.open.values()) if (q.from === from) return true;
    return false;
  }

  /** The asker's process is gone: nobody is waiting for these answers any more. */
  dropFrom(from: string): void {
    let any = false;
    for (const q of [...this.open.values()]) {
      if (q.from !== from) continue;
      this.open.delete(q.id);
      this.resolve(q.id, { answered: false, gone: true });
      any = true;
    }
    if (any) this.changed();
  }

  private resolve(id: string, r: WaitResult): void {
    const list = this.waiters.get(id) ?? [];
    this.waiters.delete(id);
    for (const settle of list) settle(r);
  }

  private forgetOldAnswers(): void {
    const cutoff = Date.now() - ANSWERED_KEEP_MS;
    for (const [id, a] of this.answered) if (a.at < cutoff) this.answered.delete(id);
  }

  private changed(): void {
    for (const cb of this.listeners) cb();
  }
}

/** Console payloads are plain data; an enormous one is replaced by a marker instead of being sent to every browser. */
function boundedPayload(p: unknown): unknown {
  try {
    return JSON.stringify(p).length <= MAX_PAYLOAD ? p : { truncated: true };
  } catch {
    return { truncated: true };
  }
}
