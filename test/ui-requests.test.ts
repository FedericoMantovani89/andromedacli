// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { applyRequests } from '../src/ui/chips';
import { createRequestsDrawer } from '../src/ui/requests';
import type { RequestRow } from '../src/shared/requests';

const chip = () => document.createElement('span');
const params = (el: HTMLElement) => JSON.parse(el.dataset.i18nParams ?? '{}');

describe('request chips', () => {
  it('hide when there is nothing', () => {
    const a = chip(), b = chip();
    applyRequests(a, b, undefined);
    expect([a.hidden, b.hidden]).toEqual([true, true]);
    expect(a.textContent).toBe('');
  });
  it('say who the agent waits for and which comment to look for', () => {
    const a = chip(), b = chip();
    applyRequests(a, b, { waiting: [{ id: 'TODO-7f3a15', to: 'be-orders' }], owed: [] });
    expect(a.hidden).toBe(false);
    expect(a.dataset.i18n).toBe('panel.requests.waiting');
    expect(params(a)).toEqual({ who: 'be-orders', id: 'TODO-7f3a15' });
    expect(b.hidden).toBe(true);
  });
  it('count the others when there are several, and show what the agent owes', () => {
    const a = chip(), b = chip();
    applyRequests(a, b, {
      waiting: [{ id: 'TODO-000001', to: 'x' }, { id: 'TODO-000002', to: 'y' }, { id: 'TODO-000003', to: 'z' }],
      owed: [{ id: 'TODO-000004', from: 'fe-pages' }],
    });
    expect(a.dataset.i18n).toBe('panel.requests.waitingMore');
    expect(params(a)).toEqual({ who: 'x', id: 'TODO-000001', more: 2 });
    expect(b.dataset.i18n).toBe('panel.requests.owed');
    expect(params(b)).toEqual({ who: 'fe-pages', id: 'TODO-000004' });
  });
  it('clear again when the requests are gone', () => {
    const a = chip(), b = chip();
    applyRequests(a, b, { waiting: [{ id: 'TODO-000001', to: 'x' }], owed: [] });
    applyRequests(a, b, undefined);
    expect(a.hidden).toBe(true);
    expect(a.dataset.i18n).toBeUndefined();
  });
});

const row = (over: Partial<RequestRow> = {}): RequestRow => ({
  id: 'TODO-7f3a15', from: 'fe-pages', to: 'be-orders', state: 'open', handler: 'be-orders', text: 'REST signatures?', hops: 0,
  createdAt: '2026-10-09T10:00:00.000Z', ...over,
});

describe('requests drawer', () => {
  it('shows one entry per request with the text as plain data, and an empty note when there are none', () => {
    const root = document.createElement('aside');
    const drawer = createRequestsDrawer(root);
    expect(root.querySelector('.queue-empty')!.hasAttribute('hidden')).toBe(false);
    drawer.update([row({ text: '<b>not html</b>' }), row({ id: 'TODO-000002', state: 'escalated', handler: 'shop-api', escalatedBy: 'timeout' })]);
    expect(root.querySelectorAll('.request-item')).toHaveLength(2);
    expect(root.querySelector('.request-text')!.innerHTML).not.toContain('<b>');
    expect(root.querySelector('.request-text')!.textContent).toBe('<b>not html</b>');
    expect(root.querySelector('.queue-empty')!.hasAttribute('hidden')).toBe(true);
  });
  it('keeps the entry of a request across updates and drops the ones that are gone', () => {
    const root = document.createElement('aside');
    const drawer = createRequestsDrawer(root);
    drawer.update([row()]);
    const first = root.querySelector('.request-item');
    drawer.update([row({ state: 'answered' })]);
    expect(root.querySelector('.request-item')).toBe(first);
    expect(root.querySelector('.request-state')!.getAttribute('data-i18n')).toBe('requests.state.answered');
    drawer.update([]);
    expect(root.querySelectorAll('.request-item')).toHaveLength(0);
  });
  it('opens and closes', () => {
    const root = document.createElement('aside');
    const drawer = createRequestsDrawer(root);
    expect(drawer.isOpen()).toBe(false);
    drawer.toggle();
    expect(drawer.isOpen()).toBe(true);
    expect(root.hidden).toBe(false);
  });
  it('close() hides it, and is harmless when it is already closed', () => {
    const root = document.createElement('aside');
    const drawer = createRequestsDrawer(root);
    drawer.toggle();
    drawer.close();
    expect(drawer.isOpen()).toBe(false);
    expect(root.hidden).toBe(true);
    drawer.close();
    expect(drawer.isOpen()).toBe(false);
  });
});

describe('queue drawer', () => {
  it('close() hides it', async () => {
    const { createQueueDrawer } = await import('../src/ui/queue');
    const root = document.createElement('aside');
    const drawer = createQueueDrawer(root);
    drawer.toggle();
    drawer.close();
    expect(drawer.isOpen()).toBe(false);
    expect(root.hidden).toBe(true);
  });
});
