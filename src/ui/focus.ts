import type { Terminal } from '@xterm/xterm';

/**
 * Which panel owns the keyboard (SPEC 5.3). The invariant: adding or removing other panels never changes it;
 * only an explicit user action calls `activate`. This is the only UI file allowed to call `.focus()`
 * (enforced by scripts/check-ui-literals.ts).
 */
export class FocusState {
  private readonly panels = new Set<string>();
  private current: string;

  constructor(private readonly mainId: string) {
    this.current = mainId;
    this.panels.add(mainId);
  }

  get active(): string { return this.current; }

  /** A new panel appears; deliberately does not touch the active one (P2). */
  onPanelAdded(id: string): void { this.panels.add(id); }

  activate(id: string): void {
    if (this.panels.has(id)) this.current = id;
  }

  remove(id: string): void {
    if (id === this.mainId) return;
    this.panels.delete(id);
    if (this.current === id) this.current = this.mainId;
  }
}

export interface PanelHandle { root: HTMLElement; term: Terminal }

/** Visual state only: border, dimming, badge, cursor blink. Never moves the keyboard focus. */
export function refreshActiveStyles(state: FocusState, panels: Map<string, PanelHandle>): void {
  for (const [id, p] of panels) {
    const active = id === state.active;
    p.root.classList.toggle('active', active);
    p.term.options.cursorBlink = active;
  }
}

/** Moves the keyboard into the active terminal. `reason` must be 'user': programmatic callers cannot use it by accident. */
export function focusActiveTerminal(state: FocusState, panels: Map<string, PanelHandle>, reason: 'user'): void {
  if (reason !== 'user') return;
  panels.get(state.active)?.term.focus();
}

/** For form fields opened by a click (the user asked for them). */
export function focusElementFromUser(el: HTMLElement, reason: 'user'): void {
  if (reason !== 'user') return;
  el.focus();
}
