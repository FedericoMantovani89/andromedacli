// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderNotificationsTab } from '../src/ui/options-notifications';
import { createQueueDrawer, queueIdFromHash } from '../src/ui/queue';
import { showBrowserNotification, titleWithCount } from '../src/ui/notify-browser';
import { DEFAULT_NOTIFICATIONS, NOTIFY_TYPES } from '../src/shared/notify';
import type { QueueItem, StateMessage } from '../src/shared/protocol';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
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
    renderNotificationsTab(c, stateWith({ toast: 'ok', config }));
    for (const type of NOTIFY_TYPES) expect(c.querySelector(`input[name="type-${type}"]`)).not.toBeNull();
    expect((c.querySelector('input[name="type-budget"]') as HTMLInputElement).checked).toBe(false);
    expect((c.querySelector('input[name="type-question"]') as HTMLInputElement).checked).toBe(true);
    expect(c.querySelectorAll('input[type="time"]')).toHaveLength(2);
    expect((c.querySelector('input[name="groupSeconds"]') as HTMLInputElement).value).toBe('5');
    expect(c.querySelector('button[name="testToast"]')).not.toBeNull();
    expect(c.querySelector('.settings-toast-status')!.getAttribute('data-i18n')).toBe('settings.notifications.toast.ok');
  });
  it('unknown toast status is shown as n/a, never as ok', () => {
    const c = document.createElement('div');
    renderNotificationsTab(c, stateWith(undefined));
    expect(c.querySelector('.settings-toast-status')!.getAttribute('data-i18n')).toBe('settings.notifications.toast.unknown');
  });
  it('a change is saved at once with only that entry', async () => {
    const calls = mockFetch();
    const c = document.createElement('div');
    renderNotificationsTab(c, stateWith({ toast: 'ok', config: DEFAULT_NOTIFICATIONS }));
    const box = c.querySelector('input[name="type-question"]') as HTMLInputElement;
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/api/config');
    expect(calls[0]!.init.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ notifications: { enabled: { question: false } } });
  });
  it('a refused save puts the switch back', async () => {
    mockFetch(422, { code: 'config.invalid', params: { path: 'notifications.sound' } });
    const c = document.createElement('div');
    renderNotificationsTab(c, stateWith({ toast: 'ok', config: DEFAULT_NOTIFICATIONS }));
    const sound = c.querySelector('input[name="sound"]') as HTMLInputElement;
    sound.checked = false;
    sound.dispatchEvent(new Event('change'));
    await flush();
    expect(sound.checked).toBe(true);
    expect(c.querySelector('.form-error')!.textContent).not.toBe('');
  });
  it('the test button posts to the test route', async () => {
    const calls = mockFetch(200, { ok: true });
    const c = document.createElement('div');
    renderNotificationsTab(c, stateWith({ toast: 'unknown', config: DEFAULT_NOTIFICATIONS }));
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
