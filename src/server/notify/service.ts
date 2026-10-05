import { randomUUID } from 'node:crypto';
import type { NotificationsConfig, NotifyMessage, NotifyType, ToastStatus } from '../../shared/notify';
import type { Translate } from '../../shared/i18n';
import { CONSOLE_FROM } from '../questions/queue';
import type { Notifier } from './notifier';
import type { Presence } from './presence';
import { eventTypeOf, type TypedItem } from './type';

export interface NotifyClock {
  now(): number;
  /** Minutes since local midnight (quiet hours are local time). */
  minutesOfDay(): number;
  /** A timer that never keeps the process alive. */
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export const realNotifyClock: NotifyClock = {
  now: () => Date.now(),
  minutesOfDay: () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); },
  setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface NotifyDeps {
  /** Read on every event: a change made in the Notifications tab applies at once. */
  config(): NotificationsConfig;
  notifier: Notifier;
  presence: Presence;
  clock: NotifyClock;
  /** The translator for server-side texts (interface language; "auto" falls back to English). */
  translate(): Translate;
  /** The address a click on the toast opens (token and plan included); `itemId` opens the queue on that item. */
  clickUrl(itemId?: string): string;
  isPending(itemId: string): boolean;
  /** The fallback message for the browser (when no toast can be shown). */
  pushBrowser(m: NotifyMessage): void;
  /** The toast status changed (the state carries it). */
  changed?(): void;
}

export interface NotifyItem extends TypedItem { id: string; from: string; text: string }

interface Event { type: NotifyType; body: string; itemId?: string }

const MAX_BODY = 120;
/** A toast that is neither clicked nor refused for this long counts as sent (the send waits for the user's reaction). */
const SEND_WAIT_MS = 3000;

const shorten = (s: string): string => { const one = s.replace(/\s+/g, ' ').trim(); return one.length > MAX_BODY ? `${one.slice(0, MAX_BODY - 1)}…` : one; };

/** SPEC 20.4 quiet hours: `from` inclusive, `to` exclusive, the window may cross midnight; from == to is an empty window. */
export function inQuietHours(q: NotificationsConfig['quietHours'], minutes: number): boolean {
  if (!q.enabled) return false;
  const at = (hhmm: string): number => { const [h, m] = hhmm.split(':').map(Number); return (h ?? 0) * 60 + (m ?? 0); };
  const from = at(q.from);
  const to = at(q.to);
  if (from === to) return false;
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/**
 * Raises a native toast for everything that needs the user (SPEC 20): event -> type enabled -> quiet hours -> the user is not
 * already looking -> group buffer -> notifier. A suppressed event still counts in the badge and the title (those come from the state).
 */
export class NotificationService {
  private buffer: Event[] = [];
  private timer: unknown;
  private closed = false;
  private available: boolean | undefined;
  private failed = false;
  private readonly interrupted = new Set<string>();

  constructor(private readonly d: NotifyDeps) {}

  /** Asks the notifier once whether a toast can be sent at all (the state shows it; never sends anything). */
  async checkAvailability(): Promise<void> {
    try { this.available = await this.d.notifier.available(); } catch { this.available = false; }
    this.d.changed?.();
  }

  toast(): ToastStatus {
    if (this.available === false || this.failed) return 'unavailable';
    return this.available === true ? 'ok' : 'unknown';
  }

  /** A new queue item (`QuestionQueue.onAdd`). */
  onItem(item: NotifyItem): void {
    const body = shorten(item.from === CONSOLE_FROM ? item.text : `${item.from}: ${item.text}`);
    this.enqueue({ type: eventTypeOf(item), body, itemId: item.id }, () => this.d.presence.suppressesItem(item.from));
  }

  /** The registry changed for a session: an agent that just became `interrupted` (not ended on purpose) is announced once. */
  onRegistryChange(a: { slug: string; role: string; state: string } | undefined): void {
    if (!a || a.role !== 'agent') return;
    if (a.state !== 'interrupted') { this.interrupted.delete(a.slug); return; }
    if (this.interrupted.has(a.slug)) return;
    this.interrupted.add(a.slug);
    const t = this.d.translate();
    this.enqueue({ type: 'interrupted', body: t('notify.interrupted', { name: a.slug }) },() => this.d.presence.suppressesAgent(a.slug));
  }

  /** The test button: one real toast through the same sender, bypassing the type switches, quiet hours, presence and grouping. */
  async test(): Promise<boolean> {
    const t = this.d.translate();
    await this.send(t('notify.test.title'), t('notify.test.message'), this.d.clickUrl());
    return this.toast() !== 'unavailable';
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) this.d.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.buffer = [];
  }

  private enqueue(ev: Event, suppressed: () => boolean): void {
    if (this.closed) return;
    const c = this.d.config();
    if (!c.enabled[ev.type]) return;
    if (inQuietHours(c.quietHours, this.d.clock.minutesOfDay())) return;
    if (suppressed()) return;
    this.buffer.push(ev);
    if (this.timer === undefined) this.timer = this.d.clock.setTimeout(() => this.flush(), c.groupSeconds * 1000);
  }

  private flush(): void {
    this.timer = undefined;
    // An item answered while it waited in the buffer is not announced any more.
    const events = this.buffer.filter((e) => e.itemId === undefined || this.d.isPending(e.itemId));
    this.buffer = [];
    if (this.closed || events.length === 0) return;
    const t = this.d.translate();
    const first = events[0]!;
    const title = events.length === 1 ? t(`notify.title.${first.type}`) : t('notify.title.group');
    const message = events.length === 1 ? first.body : t('notify.group', { count: events.length });
    void this.send(title, message, this.d.clickUrl(events.find((e) => e.itemId !== undefined)?.itemId));
  }

  private async send(title: string, message: string, open: string): Promise<void> {
    const before = this.toast();
    if (this.available === false) {
      this.d.pushBrowser({ type: 'notify', id: randomUUID(), title, message });
      return;
    }
    let threw = false;
    const clock = this.d.clock;
    let wait: unknown;
    try {
      // The notifier answers when the toast is dismissed or refused: a refusal comes fast, so a quiet toast counts as sent.
      await Promise.race([
        this.d.notifier.notify({ title, message, open, sound: this.d.config().sound }),
        new Promise<void>((done) => { wait = clock.setTimeout(done, SEND_WAIT_MS); }),
      ]);
    } catch {
      threw = true;
    } finally {
      clock.clearTimeout(wait);
    }
    this.failed = threw || this.d.notifier.lastError !== undefined;
    if (this.failed) this.d.pushBrowser({ type: 'notify', id: randomUUID(), title, message });
    if (this.toast() !== before) this.d.changed?.();
  }
}
