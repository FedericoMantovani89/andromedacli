// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/i18n-client', () => {
  const msgs: Record<string, string> = { 'header.queue': 'Queue ({count})', 'header.settings': 'Settings', 'reader.open': 'Read' };
  const t = (key: string, params?: Record<string, string | number>) => (msgs[key] ?? key).replace('{count}', String(params?.count ?? ''));
  const setTitle = (el: HTMLElement, key: string, params?: Record<string, string | number>) => {
    el.title = t(key, params);
    el.setAttribute('aria-label', t(key, params));
  };
  return { t, setTitle, k: (s: string) => s };
});

import { setIconButton, setQueueBadge } from '../src/ui/icons';

describe('icon buttons', () => {
  it('replaces the text with an svg that inherits the color, named by the key', () => {
    const b = document.createElement('button');
    b.textContent = 'old';
    setIconButton(b, 'gear', 'header.settings');
    expect(b.textContent).toBe('');
    const svg = b.querySelector('svg')!;
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(b.getAttribute('aria-label')).toBe('Settings');
    expect(b.title).toBe('Settings');
  });
  it('draws a different icon for each name', () => {
    const html = (n: 'bell' | 'gear' | 'clipboard') => { const b = document.createElement('button'); setIconButton(b, n, 'reader.open'); return b.innerHTML; };
    expect(new Set([html('bell'), html('gear'), html('clipboard')]).size).toBe(3);
  });
  it('keeps one svg when called again', () => {
    const b = document.createElement('button');
    setIconButton(b, 'bell', 'header.queue', { count: 1 });
    setIconButton(b, 'bell', 'header.queue', { count: 2 });
    expect(b.querySelectorAll('svg')).toHaveLength(1);
    expect(b.getAttribute('aria-label')).toBe('Queue (2)');
  });
  it('shows the pending count in a badge and hides it at zero', () => {
    const b = document.createElement('button');
    setIconButton(b, 'bell', 'header.queue', { count: 3 });
    setQueueBadge(b, 3);
    const badge = b.querySelector<HTMLElement>('.icon-badge')!;
    expect(badge.textContent).toBe('3');
    expect(badge.hidden).toBe(false);
    setQueueBadge(b, 0);
    expect(b.querySelectorAll('.icon-badge')).toHaveLength(1);
    expect(badge.hidden).toBe(true);
  });
});
