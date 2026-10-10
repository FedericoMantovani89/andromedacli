// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/i18n-client', () => ({
  k: (s: string) => s,
  bindText: (el: HTMLElement, key: string, params?: Record<string, string | number>) => { el.dataset.i18n = key; el.dataset.i18nParams = JSON.stringify(params ?? {}); el.textContent = key; },
}));

import { applyTicket } from '../src/ui/chips';

describe('ticket chip while the tests wait for the machine queue', () => {
  it('shows the waiting state with the place, even while the ticket is still being written', () => {
    const el = document.createElement('span');
    applyTicket(el, { status: 'in_progress', round: 0, maxRounds: 2, testQueue: 2 });
    expect(el.hidden).toBe(false);
    expect(el.dataset.i18n).toBe('ticket.waitingTests');
    expect(JSON.parse(el.dataset.i18nParams!)).toMatchObject({ n: 2 });
  });
  it('is unchanged without a queue', () => {
    const el = document.createElement('span');
    applyTicket(el, { status: 'in_progress', round: 0, maxRounds: 2 });
    expect(el.hidden).toBe(true);
  });
});
