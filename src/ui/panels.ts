import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { SessionInfo } from '../shared/protocol';
import { computeAgentLayout } from '../shared/layout';
import { wsUrl } from './api';
import { bindText, k } from './i18n-client';
import { FocusState, focusActiveTerminal, refreshActiveStyles, type PanelHandle } from './focus';

const STATE_KEYS: Record<SessionInfo['status'], string> = {
  running: k('state.running'),
  exited: k('state.exited'),
};

interface Panel extends PanelHandle {
  setStatus(status: SessionInfo['status']): void;
  dispose(): void;
}

/** One terminal panel: an xterm.js instance wired to /ws/term/<slug>. The server owns the process and the scrollback. */
function createPanel(info: SessionInfo, onActivate: (slug: string) => void): Panel {
  const root = document.createElement('div');
  root.className = 'panel';
  root.dataset.slug = info.slug;

  const header = document.createElement('div');
  header.className = 'panel-header';
  const title = document.createElement('span');
  title.className = 'panel-title';
  title.textContent = info.slug; // P1: the slug is the panel title
  const meta = document.createElement('span');
  meta.className = 'panel-meta';
  if (info.role === 'main') bindText(meta, 'panel.main');
  else meta.textContent = info.profile;
  const badge = document.createElement('span');
  badge.className = 'badge';
  bindText(badge, 'panel.badge.activeInput');
  const stateEl = document.createElement('span');
  header.append(title, meta, badge, stateEl);

  const host = document.createElement('div');
  host.className = 'panel-term';
  root.append(header, host);

  const term = new Terminal({ scrollback: 20000, cursorBlink: false, fontSize: 13, convertEol: false });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);

  let ws: WebSocket | undefined;
  let closed = false;
  let retry = 500;

  const sendResize = () => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  };
  const refit = () => {
    try { fit.fit(); } catch { /* panel not laid out yet */ }
    sendResize();
  };

  const connect = () => {
    ws = new WebSocket(wsUrl(`/ws/term/${info.slug}`));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      term.reset(); // the server replays the whole scrollback on every connection
      retry = 500;
      refit();
    };
    ws.onmessage = (ev) => term.write(new Uint8Array(ev.data as ArrayBuffer));
    ws.onclose = () => {
      if (closed) return;
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 5000);
    };
  };
  connect();

  const encoder = new TextEncoder();
  term.onData((d) => { if (ws?.readyState === WebSocket.OPEN) ws.send(encoder.encode(d)); });

  const observer = new ResizeObserver(refit);
  observer.observe(host);
  // A click is a user action: it is the only thing (besides shortcuts) that moves the focus.
  root.addEventListener('mousedown', () => onActivate(info.slug));

  return {
    root, term,
    setStatus: (status) => {
      bindText(stateEl, STATE_KEYS[status]);
      stateEl.className = `panel-state ${status}`;
    },
    dispose: () => {
      closed = true;
      observer.disconnect();
      ws?.close();
      term.dispose();
    },
  };
}

/**
 * Makes `parent`'s children equal `desired` while moving as few nodes as possible. Re-parenting a node makes the
 * browser drop its keyboard focus, so a state update must never shuffle the panel the user is typing in (P2).
 */
function reconcile(parent: HTMLElement, desired: HTMLElement[]): void {
  desired.forEach((child, i) => {
    if (parent.children[i] !== child) parent.insertBefore(child, parent.children[i] ?? null);
  });
  while (parent.children.length > desired.length) parent.lastElementChild!.remove();
}

/** Owns the panels of the whole workspace: the fixed main on the left, the agents stacked on the right. */
export class Workspace {
  private readonly panels = new Map<string, Panel>();
  private readonly focus: FocusState;
  private expanded: string | null = null;
  private mainId = '';
  private lastMain: SessionInfo | undefined;
  private lastAgents: SessionInfo[] = [];
  private newAgentControl: HTMLElement | undefined;
  /** Bars are kept between updates: rebuilding them would move every node after them and drop the keyboard focus. */
  private readonly bars = new Map<string, { el: HTMLElement; state: HTMLElement }>();

  constructor(private readonly mainCol: HTMLElement, private readonly agentsCol: HTMLElement, mainId: string) {
    this.mainId = mainId;
    this.focus = new FocusState(mainId);
  }

  setNewAgentControl(el: HTMLElement): void {
    this.newAgentControl = el;
  }

  get active(): string { return this.focus.active; }

  /** User-initiated activation (click or shortcut): the only path that moves the keyboard. */
  activate(slug: string): void {
    this.focus.activate(slug);
    refreshActiveStyles(this.focus, this.panels);
    focusActiveTerminal(this.focus, this.panels, 'user');
  }

  /** Alt+1 is main, Alt+2.. the agents in order (SPEC 5.4). */
  activateByIndex(index: number): void {
    const order = [this.mainId, ...this.lastAgents.map((a) => a.slug)];
    const slug = order[index];
    if (slug && this.panels.has(slug)) this.activate(slug);
  }

  update(main: SessionInfo, agents: SessionInfo[]): void {
    this.lastAgents = agents;
    this.lastMain = main;
    this.mainId = main.slug;
    this.ensurePanel(main);
    if (this.mainCol.firstElementChild !== this.panels.get(main.slug)!.root) {
      this.mainCol.replaceChildren(this.panels.get(main.slug)!.root);
    }
    this.panels.get(main.slug)!.setStatus(main.status);

    const bySlug = new Map(agents.map((a) => [a.slug, a]));
    const layout = computeAgentLayout(agents.map((a) => a.slug), this.expanded);
    const children: HTMLElement[] = [];
    for (const item of layout) {
      const info = bySlug.get(item.slug)!;
      if (item.mode === 'panel') {
        const p = this.ensurePanel(info);
        p.setStatus(info.status);
        children.push(p.root);
      } else {
        this.dropPanel(item.slug); // the server keeps the scrollback; reconnecting restores it
        children.push(this.bar(info));
      }
    }
    const barSlugs = new Set(layout.filter((l) => l.mode === 'bar').map((l) => l.slug));
    for (const slug of [...this.bars.keys()]) if (!barSlugs.has(slug)) this.bars.delete(slug);
    for (const slug of [...this.panels.keys()]) {
      if (slug !== main.slug && !bySlug.has(slug)) this.dropPanel(slug);
    }
    if (this.newAgentControl) children.push(this.newAgentControl);
    reconcile(this.agentsCol, children);
    refreshActiveStyles(this.focus, this.panels); // styles only: a new panel never takes the focus (P2)
  }

  /** Focus the main terminal once when the console is opened (the user just opened it). */
  focusMainOnOpen(): void {
    focusActiveTerminal(this.focus, this.panels, 'user');
  }

  private ensurePanel(info: SessionInfo): Panel {
    let p = this.panels.get(info.slug);
    if (!p) {
      p = createPanel(info, (slug) => this.activate(slug));
      this.panels.set(info.slug, p);
      this.focus.onPanelAdded(info.slug);
    }
    return p;
  }

  private dropPanel(slug: string): void {
    const p = this.panels.get(slug);
    if (!p) return;
    p.dispose();
    this.panels.delete(slug);
    this.focus.remove(slug);
  }

  private bar(info: SessionInfo): HTMLElement {
    const cached = this.bars.get(info.slug);
    if (cached) {
      bindText(cached.state, STATE_KEYS[info.status]);
      cached.state.className = `panel-state ${info.status}`;
      return cached.el;
    }
    const el = document.createElement('div');
    el.className = 'bar';
    const title = document.createElement('span');
    title.className = 'panel-title';
    title.textContent = info.slug;
    const meta = document.createElement('span');
    meta.className = 'panel-meta';
    meta.textContent = info.profile;
    const state = document.createElement('span');
    state.className = `panel-state ${info.status}`;
    bindText(state, STATE_KEYS[info.status]);
    const expand = document.createElement('button');
    bindText(expand, 'panel.expand');
    expand.addEventListener('click', () => { this.expanded = info.slug; this.update(this.lastMain!, this.lastAgents); });
    el.append(title, meta, state, expand);
    this.bars.set(info.slug, { el, state });
    return el;
  }
}
