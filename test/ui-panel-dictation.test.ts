// @vitest-environment jsdom
// The microphone button lives in the main panel's header only, is built once, and never takes the keyboard.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Workspace } from '../src/ui/panels';
import type { SessionInfo } from '../src/shared/protocol';

const session = (slug: string, role: 'main' | 'agent'): SessionInfo => ({ slug, profile: role === 'main' ? 'main' : 'developer', role, status: 'running', state: 'idle' });

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener(): void {}, removeEventListener(): void {}, addListener(): void {}, removeListener(): void {} }));
  window.matchMedia = globalThis.matchMedia;
  vi.stubGlobal('WebSocket', class { binaryType = ''; readyState = 0; close(): void {} send(): void {} addEventListener(): void {} });
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} unobserve(): void {} });
});

function build(agents: SessionInfo[]): { ws: Workspace; main: HTMLElement; agentsCol: HTMLElement } {
  document.body.innerHTML = '<section id="m"></section><section id="a"></section>';
  const main = document.getElementById('m')!;
  const agentsCol = document.getElementById('a')!;
  const ws = new Workspace(main, agentsCol, 'shop', 'shop');
  ws.update(session('shop', 'main'), agents);
  return { ws, main, agentsCol };
}

describe('dictation button in the main panel', () => {
  it('is only in the main panel header, beside the state, with the mic icon', () => {
    const { main, agentsCol } = build([session('fix-a', 'agent'), session('fix-b', 'agent')]);
    const btn = main.querySelector<HTMLElement>('.panel-header .panel-dictate')!;
    expect(btn).not.toBeNull();
    expect(btn.querySelector('svg[data-icon="mic"]')).not.toBeNull();
    expect(btn.getAttribute('aria-label')).toBeTruthy();
    expect(agentsCol.querySelector('.panel-dictate')).toBeNull();
    expect(document.querySelectorAll('.panel-dictate')).toHaveLength(1);
  });

  it('is the same node after a state update (the header is not rebuilt)', () => {
    const { ws, main } = build([session('fix-a', 'agent')]);
    const before = main.querySelector('.panel-dictate');
    ws.update({ ...session('shop', 'main'), state: 'working' }, [session('fix-a', 'agent'), session('fix-b', 'agent')]);
    expect(main.querySelector('.panel-dictate')).toBe(before);
  });

  it('does not take the keyboard on mouse down and asks for the dialog on click', () => {
    const { main } = build([]);
    const btn = main.querySelector<HTMLElement>('.panel-dictate')!;
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    btn.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    const asked = vi.fn();
    window.addEventListener('console-open-dictation', asked);
    btn.click();
    expect(asked).toHaveBeenCalledTimes(1);
    window.removeEventListener('console-open-dictation', asked);
  });

  it('is not in the header of the page any more', () => {
    expect(document.getElementById('dictation-btn')).toBeNull();
  });
});
