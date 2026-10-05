// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderStatusBar } from '../src/ui/statusbar';
import type { SessionInfo, StateMessage } from '../src/shared/protocol';

const params = (el: Element) => JSON.parse((el as HTMLElement).dataset.i18nParams ?? '{}');
const byKey = (root: HTMLElement, key: string): HTMLElement | undefined => [...root.querySelectorAll<HTMLElement>('[data-i18n]')].find((e) => e.dataset.i18n === key);
const info = (slug: string, state: SessionInfo['state'], status: SessionInfo['status'] = 'running'): SessionInfo => ({ slug, state, status, role: 'agent', profile: 'backend' });
const make = (extra: Partial<StateMessage> = {}): StateMessage => ({ main: info('main', 'idle'), agents: [], ...extra } as unknown as StateMessage);

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('quota item', () => {
  it('shows the rounded percent when the state has one', () => {
    const el = document.createElement('div');
    renderStatusBar(el, make({ quota: { percent: 72.4, kind: 'five_hour' } }));
    const q = byKey(el, 'statusbar.quota')!;
    expect(params(q)).toEqual({ percent: 72 });
    expect(byKey(el, 'statusbar.quotaLabel')).toBeUndefined();
  });
  it('shows n/a, never zero, when the quota is absent, and goes back to a percent', () => {
    const el = document.createElement('div');
    renderStatusBar(el, make());
    expect(byKey(el, 'statusbar.quotaLabel')).toBeDefined();
    expect(byKey(el, 'statusbar.quota')).toBeUndefined();
    expect(el.querySelectorAll('[data-i18n="common.notAvailable"]').length).toBeGreaterThanOrEqual(2); // the budget and the quota
    renderStatusBar(el, make({ quota: { percent: 5, kind: 'five_hour' } }));
    expect(params(byKey(el, 'statusbar.quota')!)).toEqual({ percent: 5 });
  });
});

describe('agent counter', () => {
  it('uses the effective limit when the state carries it', () => {
    const el = document.createElement('div');
    renderStatusBar(el, make({ limits: { active: 3, max: 2 } }));
    expect(params(byKey(el, 'statusbar.agentsOf')!)).toEqual({ active: 3, max: 2 });
    expect(byKey(el, 'statusbar.agents')).toBeUndefined();
  });
  it('falls back to the plain count without it', () => {
    const el = document.createElement('div');
    renderStatusBar(el, make({ agents: [info('a', 'working'), info('b', 'idle', 'exited')] }));
    expect(params(byKey(el, 'statusbar.agents')!)).toEqual({ count: 1 });
  });
});

describe('sleep indicator and the resume button', () => {
  it('is hidden without a sleep, and shows the time and a countdown when sleeping', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T10:00:00Z'));
    const el = document.createElement('div');
    renderStatusBar(el, make());
    const sleep = byKey(el, 'statusbar.sleep');
    expect(sleep).toBeUndefined();
    const button = el.querySelector<HTMLButtonElement>('button')!;
    expect(button.hidden).toBe(false); // always visible (SPEC 18.4) ...
    expect(button.disabled).toBe(true); // ... usable only while sleeping
    renderStatusBar(el, make({ sleep: { until: '2026-10-05T12:00:05.000Z', phase: 'sleeping', attempt: 0, weekly: false } }));
    const shown = byKey(el, 'statusbar.sleep')!;
    expect(shown.hidden).toBe(false);
    expect(params(shown).remaining).toBe('2:00:05');
    expect(typeof params(shown).time).toBe('string');
    expect(button.hidden).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.dataset.i18n).toBe('statusbar.resumeNow');
    // the countdown moves on its own between state pushes
    vi.advanceTimersByTime(5000);
    expect(params(byKey(el, 'statusbar.sleep')!).remaining).toBe('2:00:00');
    // the sleep goes when the state says so; the button stays, disabled
    renderStatusBar(el, make());
    expect(button.hidden).toBe(false);
    expect(button.disabled).toBe(true);
    expect(byKey(el, 'statusbar.sleep')).toBeUndefined();
  });
  it('a weekly limit uses its own text; probing says so and disables the button', () => {
    const el = document.createElement('div');
    renderStatusBar(el, make({ sleep: { until: '2026-10-08T10:00:00Z', phase: 'sleeping', attempt: 0, weekly: true } }));
    expect(byKey(el, 'statusbar.sleepWeekly')).toBeDefined();
    renderStatusBar(el, make({ sleep: { phase: 'probing', attempt: 1, weekly: false } }));
    expect(byKey(el, 'statusbar.sleepProbing')).toBeDefined();
    expect(el.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
    renderStatusBar(el, make());
  });
  it('an unknown time is n/a, never a made-up one', () => {
    const el = document.createElement('div');
    renderStatusBar(el, make({ sleep: { phase: 'sleeping', attempt: 0, weekly: true } }));
    expect(params(byKey(el, 'statusbar.sleepWeekly')!).time).toBe('common.notAvailable'); // no bundle loaded in the test: the key itself
    renderStatusBar(el, make());
  });
  it('the button POSTs /api/sleep/resume', async () => {
    const calls: { url: string; method?: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string }) => { calls.push({ url, method: init.method }); return { status: 204, json: async () => { throw new Error('empty'); } }; }));
    const el = document.createElement('div');
    renderStatusBar(el, make({ sleep: { until: '2026-10-05T12:00:05.000Z', phase: 'sleeping', attempt: 0, weekly: false } }));
    el.querySelector<HTMLButtonElement>('button')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([{ url: '/api/sleep/resume', method: 'POST' }]);
    renderStatusBar(el, make());
  });
  it('the nodes are stable across pushes (a focused button is never replaced)', () => {
    const el = document.createElement('div');
    renderStatusBar(el, make());
    const button = el.querySelector('button');
    const children = [...el.children];
    renderStatusBar(el, make({ quota: { percent: 80, kind: 'five_hour' }, sleep: { until: '2026-10-05T12:00:05.000Z', phase: 'sleeping', attempt: 0, weekly: false } }));
    renderStatusBar(el, make());
    expect(el.querySelector('button')).toBe(button);
    expect([...el.children]).toEqual(children);
  });
});

describe('fix wave', () => {
  it('a weekly reset more than a day away shows the date, not only the hour', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T10:00:00Z'));
    const el = document.createElement('div');
    renderStatusBar(el, make({ sleep: { until: '2026-10-08T10:00:00Z', phase: 'sleeping', attempt: 0, weekly: true } }));
    const weekly = params(byKey(el, 'statusbar.sleepWeekly')!).time as string;
    const hourOnly = new Date('2026-10-08T10:00:00Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    expect(weekly).not.toBe(hourOnly);
    expect(weekly).toContain('8');
    // a reset within the day keeps the short form
    renderStatusBar(el, make({ sleep: { until: '2026-10-05T12:00:05.000Z', phase: 'sleeping', attempt: 0, weekly: false } }));
    expect(params(byKey(el, 'statusbar.sleep')!).time).toBe(new Date('2026-10-05T12:00:05.000Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    renderStatusBar(el, make());
  });
  it('the resume button never takes the keyboard focus (mousedown is prevented)', () => {
    const el = document.createElement('div');
    renderStatusBar(el, make({ sleep: { until: '2026-10-05T12:00:05.000Z', phase: 'sleeping', attempt: 0, weekly: false } }));
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    el.querySelector<HTMLButtonElement>('button')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    renderStatusBar(el, make());
  });
});
