import { randomUUID } from 'node:crypto';

export interface InboxMessage { id: string; text: string }

/**
 * Messages from the console to a session (goals, answers). The mod polls, acknowledges, then injects the text as a new
 * turn; a message that was not acknowledged is delivered again (SPEC 10.5 "conferma di ricezione").
 */
export class Inbox {
  private readonly boxes = new Map<string, InboxMessage[]>();

  push(slug: string, text: string): string {
    const id = randomUUID();
    const box = this.boxes.get(slug) ?? [];
    box.push({ id, text });
    this.boxes.set(slug, box);
    return id;
  }

  pending(slug: string): InboxMessage[] {
    return [...(this.boxes.get(slug) ?? [])];
  }

  /** True when the message existed in that session's box. */
  ack(slug: string, id: string): boolean {
    const box = this.boxes.get(slug);
    const i = box?.findIndex((m) => m.id === id) ?? -1;
    if (!box || i < 0) return false;
    box.splice(i, 1);
    return true;
  }

  clear(slug: string): void { this.boxes.delete(slug); }
}
