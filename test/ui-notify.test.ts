// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderNotificationsTab } from '../src/ui/options-notifications';
import { createQueueDrawer, queueIdFromHash } from '../src/ui/queue';
import { showBrowserNotification, titleWithCount } from '../src/ui/notify-browser';
import { DEFAULT_NOTIFICATIONS, NOTIFY_TYPES } from '../src/shared/notify';
import type { QueueItem, StateMessage } from '../src/shared/protocol';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
type Run = (dry: boolean) => Promise<{ status: number; body: unknown }>;
/** A stand-in for the dialog's staging: keeps the last request of each key, like the real one. */
const staging = (): { stage: (key: string, run: Run) => void; staged: Map<string, Run> } => {
  const staged = new Map<string, Run>();
  return { staged, stage: (key, run) => { staged.delete(key); staged.set(key, run); } };
};
const stateWith = (notifications?: StateMessage['notifications']): StateMessage => ({ notifications } as StateMessage);

function mockFetch(status = 200, body: unknown = {}) {
  const calls: { path: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    return { status, json: async () => body };
  }));
  return calls;
}
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('Notifications tab', () => {
  it('shows one switch per event type with the saved values, quiet hours, sound, grouping and the test button', () => {
    const c = document.createElement('div');
    const config = { ...DEFAULT_NOTIFICATIONS, enabled: { ...DEFAULT_NOTIFICATIONS.enabled, budget: false } };
    renderNotificationsTab(c, stateWith({ toast: 'ok', config }), staging().stage);
    for (const type of NOTIFY_TYPES) expect(c.querySelector(`input[name="type-${type}"]`)).not.toBeNull();
    expect((c.querySelector('input[name="type-budget"]') as HTMLInputElement).checked).toBe(false);
    expect((c.querySelector('input[name="type-question"]') as HTMLInputElement).checked).toBe(true);
    expect(c.querySelectorAll('button.clock-button')).toHaveLength(2); // a clock face instead of a typed time
    expect((c.querySelector('input[name="quiet-from"]') as HTMLInputElement).value).toBe(config.quietHours.from);
    expect((c.querySelector('button[name="quiet-from-clock"]') as HTMLElement).textContent).toBe(config.quietHours.from);
    expect((c.querySelector('input[name="groupSeconds"]') as HTMLInputElement).value).toBe('5');
    expect(c.querySelector('button[name="testToast"]')).not.toBeNull();
    expect(c.querySelector('.settings-toast-status')!.getAttribute('data-i18n')).toBe('settings.notifications.toast.ok');
  });
  it('the clock face picks hour then minute (here with the keyboard), stages the time and closes', async () => {
    const c = document.createElement('div');
    document.body.append(c);
    const { stage, staged } = staging();
    renderNotificationsTab(c, stateWith({ toast: 'ok', config: { ...DEFAULT_NOTIFICATIONS, quietHours: { enabled: true, from: '22:00', to: '07:00' } } }), stage);
    c.querySelector<HTMLElement>('button[name="quiet-from-clock"]')!.click();
    const face = document.querySelector<SVGElement>('.clock-face')!;
    const key = (k: string) => face.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('ArrowUp'); // 23
    key('Enter'); // on to the minutes
    key('ArrowDown');
    key('ArrowDown'); // 58
    key('Enter'); // done
    expect(document.querySelector('.clock-popover')).toBeNull();
    expect((c.querySelector('input[name="quiet-from"]') as HTMLInputElement).value).toBe('23:58');
    expect((c.querySelector('button[name="quiet-from-clock"]') as HTMLElement).textContent).toBe('23:58');
    expect([...staged.keys()]).toEqual(['notifications:quietHours.from']);
    // Escape closes the dial and leaves the time alone
    c.querySelector<HTMLElement>('button[name="quiet-to-clock"]')!.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.clock-popover')).toBeNull();
    expect((c.querySelector('input[name="quiet-to"]') as HTMLInputElement).value).toBe('07:00');
  });
  it('the two clocks are disabled while the quiet hours box is off', () => {
    const c = document.createElement('div');
    renderNotificationsTab(c, stateWith({ toast: 'ok', config: { ...DEFAULT_NOTIFICATIONS, quietHours: { enabled: false, from: '22:00', to: '07:00' } } }), staging().stage);
    const clocks = [...c.querySelectorAll<HTMLButtonElement>('button.clock-button')];
    expect(clocks.map((b) => b.disabled)).toEqual([true, true]);
    const box = c.querySelector<HTMLInputElement>('input[name="quietEnabled"]')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(clocks.map((b) => b.disabled)).toEqual([false, false]);
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(clocks.map((b) => b.disabled)).toEqual([true, true]);
  });
  it('unknown toast status is shown as n/a, never as ok', () => {
    const c = document.createElement('div');
    renderNotificationsTab(c, stateWith(undefined), staging().stage);
    expect(c.querySelector('.settings-toast-status')!.getAttribute('data-i18n')).toBe('settings.notifications.toast.unknown');
  });
  it('a change is staged, not sent, and carries only that entry', async () => {
    const calls = mockFetch();
    const { stage, staged } = staging();
    const c = document.createElement('div');
    renderNotificationsTab(c, stateWith({ toast: 'ok', config: DEFAULT_NOTIFICATIONS }), stage);
    const box = c.querySelector('input[name="type-question"]') as HTMLInputElement;
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    await flush();
    expect(calls).toHaveLength(0);
    expect([...staged.keys()]).toEqual(['notifications:enabled.question']);
    await [...staged.values()][0]!(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/api/config');
    expect(calls[0]!.init.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ notifications: { enabled: { question: false } } });
  });
  it('changing the same setting twice keeps only the last one', () => {
    const { stage, staged } = staging();
    const c = document.createElement('div');
    renderNotificationsTab(c, stateWith({ toast: 'ok', config: DEFAULT_NOTIFICATIONS }), stage);
    const sound = c.querySelector('input[name="sound"]') as HTMLInputElement;
    for (const v of [false, true]) { sound.checked = v; sound.dispatchEvent(new Event('change')); }
    expect(staged.size).toBe(1);
  });
  it('the test button posts to the test route', async () => {
    const calls = mockFetch(200, { ok: true });
    const c = document.createElement('div');
    renderNotificationsTab(c, stateWith({ toast: 'unknown', config: DEFAULT_NOTIFICATIONS }), staging().stage);
    (c.querySelector('button[name="testToast"]') as HTMLButtonElement).click();
    await flush();
    expect(calls[0]!.path).toBe('/api/notifications/test');
    expect(c.querySelector('.settings-toast-status')!.getAttribute('data-i18n')).toBe('settings.notifications.toast.ok');
  });
});

describe('#queue= deep link', () => {
  it.each([['#queue=abc-123', 'abc-123'], ['#queue=', undefined], ['', undefined], ['#other=1', undefined], ['#queue=a b', undefined], ['#queue=<x>', undefined]])('%s', (hash, expected) => {
    expect(queueIdFromHash(hash)).toBe(expected);
  });
  it('openOn opens the drawer without moving the keyboard focus', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const drawer = createQueueDrawer(root);
    const item: QueueItem = { id: 'q1', from: 'fix-login', kind: 'question', text: 'Which?', createdAt: '2026-10-05T00:00:00Z' };
    drawer.update([item]);
    const outside = document.createElement('input');
    document.body.append(outside);
    outside.focus(); // test code, not under src/ui
    expect(drawer.isOpen()).toBe(false);
    drawer.openOn('q1');
    expect(drawer.isOpen()).toBe(true);
    expect(document.activeElement).toBe(outside);
    drawer.openOn('gone'); // an item answered meanwhile: the drawer still opens
    expect(drawer.isOpen()).toBe(true);
  });
});

describe('title counter and browser fallback', () => {
  it('prefixes the number of waiting items and never stacks prefixes', () => {
    expect(titleWithCount('AndromedaCli v0.0.1', 2)).toBe('(2) AndromedaCli v0.0.1');
    expect(titleWithCount('(2) AndromedaCli v0.0.1', 3)).toBe('(3) AndromedaCli v0.0.1');
    expect(titleWithCount('(3) AndromedaCli v0.0.1', 0)).toBe('AndromedaCli v0.0.1');
  });
  it('shows a browser notification only when enabled, granted and the tab is not in front', () => {
    const shown: unknown[] = [];
    class Fake { static permission = 'granted'; constructor(title: string, o: unknown) { shown.push([title, o]); } }
    vi.stubGlobal('Notification', Fake);
    const msg = { type: 'notify' as const, id: 'n1', title: 'T', message: 'M' };
    const on = { ...DEFAULT_NOTIFICATIONS, browserFallback: true };
    expect(showBrowserNotification(msg, on, true)).toBe(false);
    expect(showBrowserNotification(msg, DEFAULT_NOTIFICATIONS, false)).toBe(false);
    expect(showBrowserNotification(msg, undefined, false)).toBe(false);
    expect(showBrowserNotification(msg, on, false)).toBe(true);
    expect(shown).toEqual([['T', { body: 'M', tag: 'n1' }]]);
    Fake.permission = 'denied';
    expect(showBrowserNotification(msg, on, false)).toBe(false);
  });
});
