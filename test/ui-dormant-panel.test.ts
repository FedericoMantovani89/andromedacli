// @vitest-environment jsdom
// The expanded panel of a dormant agent: the agent's last words in full, n/a when there are none, and a working Wake up button.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { path: string; method?: string }[] = [];
let reading: { status: number; body: unknown } = { status: 200, body: { entries: [] } };
let wakeStatus = 200;
vi.mock('../src/ui/api', () => ({
  api: vi.fn(async (path: string, o?: { method?: string }) => {
    calls.push({ path, method: o?.method });
    if (path.startsWith('/api/reading/')) return reading;
    return { status: wakeStatus, body: wakeStatus === 200 ? {} : { code: 'agent.noWake' } };
  }),
}));

import { createDormantPanel } from '../src/ui/dormant-panel';
import type { SessionInfo } from '../src/shared/protocol';

const info: SessionInfo = { slug: 'fix-export', state: 'dormant', status: 'exited', role: 'agent', profile: 'developer' };
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { calls.length = 0; reading = { status: 200, body: { entries: [] } }; wakeStatus = 200; });

describe('createDormantPanel', () => {
  it('prints the last entries in full, as text, and has no terminal', async () => {
    const long = 'x'.repeat(500);
    reading = { status: 200, body: { entries: [{ text: 'first' }, { text: '' }, { text: `<b>${long}</b>` }] } };
    const el = createDormantPanel(info);
    await flush();
    const entries = [...el.querySelectorAll('.panel-dormant-entry')].map((e) => e.textContent);
    expect(entries).toEqual(['first', `<b>${long}</b>`]); // empty entries skipped, nothing cut, markup stays text
    expect(el.querySelector('b')).toBeNull();
    expect(el.querySelector('.panel-term, .xterm')).toBeNull();
    expect(el.querySelector('.panel-title')!.textContent).toBe('fix-export');
  });
  it('says n/a when the agent said nothing or the reading cannot be loaded', async () => {
    const empty = createDormantPanel(info);
    await flush();
    expect(empty.querySelector('.panel-dormant-body [data-i18n]')!.getAttribute('data-i18n')).toBe('common.notAvailable');
    reading = { status: 404, body: null };
    const gone = createDormantPanel(info);
    await flush();
    expect(gone.querySelector('.panel-dormant-body [data-i18n]')!.getAttribute('data-i18n')).toBe('common.notAvailable');
  });
  it('Wake up posts to the agent and shows the error when the console refuses', async () => {
    const el = createDormantPanel(info);
    const wake = el.querySelector<HTMLButtonElement>('.panel-wake')!;
    wake.click();
    await flush();
    expect(calls).toContainEqual({ path: '/api/agents/fix-export/wake', method: 'POST' });
    expect(wake.disabled).toBe(true); // the next state push replaces the panel
    wakeStatus = 409;
    const again = createDormantPanel(info);
    const btn = again.querySelector<HTMLButtonElement>('.panel-wake')!;
    btn.click();
    await flush();
    expect(btn.disabled).toBe(false);
    expect(again.querySelector('.form-error')!.textContent).not.toBe('');
  });
});
