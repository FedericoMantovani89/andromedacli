import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Activity } from '../shared/activity';
import type { SessionInfo } from '../shared/protocol';
import { computeAgentLayout } from '../shared/layout';
import { wsUrl } from './api';
import { reconcile } from './dom';
import { bindText, k } from './i18n-client';
import { STATE_KEYS, applyBudget, applyLoop, applyProgress, applyTicket } from './chips';
import { FocusState, focusActiveTerminal, refreshActiveStyles, type PanelHandle } from './focus';

/** "Not started yet" next to the state when the launch check found the agent stalled. */
function applyStalled(el: HTMLElement, stalled: boolean | undefined): void {
  el.hidden = !stalled;
  if (stalled) bindText(el, k('panel.launchStalled'));
  else el.textContent = '';
}

interface Panel extends PanelHandle {
  setState(state: Activity, progress?: SessionInfo['progress'], stalled?: boolean, ticket?: SessionInfo['ticket'], budget?: SessionInfo['budget'], loop?: SessionInfo['loop']): void;
  dispose(): void;
  /** Fits the terminal to its box again (after the plan's tab was hidden). */
  refit(): void;
}

/** One terminal panel: an xterm.js instance wired to /ws/term/<slug>. The server owns the process and the scrollback. */
function createPanel(info: SessionInfo, onActivate: (slug: string) => void, plan: string | undefined): Panel {
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
  const progressEl = document.createElement('span');
  progressEl.className = 'panel-progress';
  progressEl.hidden = true;
  const stalledEl = document.createElement('span');
  stalledEl.className = 'panel-stalled';
  stalledEl.hidden = true;
  const ticketEl = document.createElement('span');
  ticketEl.className = 'panel-ticket';
  ticketEl.hidden = true;
  const budgetEl = document.createElement('span');
  budgetEl.className = 'panel-budget';
  budgetEl.hidden = true;
  const readBtn = document.createElement('button');
  const loopEl = document.createElement('span');
  loopEl.className = 'panel-loop';
  loopEl.hidden = true;
  readBtn.className = 'panel-read';
  bindText(readBtn, 'reader.open');
  readBtn.addEventListener('mousedown', (ev) => ev.preventDefault()); // a button here must not take the keyboard
  readBtn.addEventListener('click', () => window.dispatchEvent(new CustomEvent('console-open-reader', { detail: info.slug })));
  header.append(title, meta, badge, stateEl, stalledEl, ticketEl, budgetEl, loopEl, progressEl, readBtn);

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
    ws = new WebSocket(wsUrl(`/ws/term/${info.slug}`, plan));
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
    root, term, refit,
    setState: (state, progress, stalled, ticket, budget, loop) => {
      applyLoop(loopEl, loop);
      applyStalled(stalledEl, stalled);
      applyTicket(ticketEl, ticket);
      bindText(stateEl, STATE_KEYS[state]);
      stateEl.className = `panel-state ${state}`;
      applyProgress(progressEl, progress);
      applyBudget(budgetEl, { state, ticket, budget });
    },
    dispose: () => {
      closed = true;
      observer.disconnect();
      ws?.close();
      term.dispose();
    },
  };
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
  private readonly bars = new Map<string, { el: HTMLElement; state: HTMLElement; progress: HTMLElement; stalled: HTMLElement; ticket: HTMLElement; budget: HTMLElement; loop: HTMLElement; pending: boolean }>();

  /** `plan` is the plan this workspace shows: its terminals connect with it, whichever tab is on screen. */
  constructor(private readonly mainCol: HTMLElement, private readonly agentsCol: HTMLElement, mainId: string, private readonly plan?: string) {
    this.mainId = mainId;
    this.focus = new FocusState(mainId);
  }

  /** The plan was closed: every terminal connection ends. */
  dispose(): void {
    for (const slug of [...this.panels.keys()]) this.dropPanel(slug);
  }

  /** The plan's tab was selected (a user action): fit its terminals again, then make its active panel the active input. */
  show(): void {
    for (const p of this.panels.values()) p.refit();
    this.activate(this.focus.active);
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
    this.panels.get(main.slug)!.setState(main.state, main.progress);

    const bySlug = new Map(agents.map((a) => [a.slug, a]));
    // Agents without a process yet (waiting in the queue) are always bars; the rest follow the 4-panels rule.
    const live = agents.filter((a) => a.status !== 'pending');
    const layout = [
      ...computeAgentLayout(live.map((a) => a.slug), this.expanded),
      ...agents.filter((a) => a.status === 'pending').map((a) => ({ slug: a.slug, mode: 'bar' as const })),
    ];
    const children: HTMLElement[] = [];
    for (const item of layout) {
      const info = bySlug.get(item.slug)!;
      if (item.mode === 'panel') {
        const p = this.ensurePanel(info);
        p.setState(info.state, info.progress, info.launchStalled, info.ticket, info.budget, info.loop);
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
      p = createPanel(info, (slug) => this.activate(slug), this.plan);
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
    const pending = info.status === 'pending';
    if (cached && cached.pending === pending) {
      bindText(cached.state, STATE_KEYS[info.state]);
      cached.state.className = `panel-state ${info.state}`;
      applyProgress(cached.progress, info.progress);
      applyStalled(cached.stalled, info.launchStalled);
      applyTicket(cached.ticket, info.ticket);
      applyBudget(cached.budget, info);
      applyLoop(cached.loop, info.loop);
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
    state.className = `panel-state ${info.state}`;
    bindText(state, STATE_KEYS[info.state]);
    const progress = document.createElement('span');
    progress.className = 'panel-progress';
    applyProgress(progress, info.progress);
    const stalled = document.createElement('span');
    stalled.className = 'panel-stalled';
    applyStalled(stalled, info.launchStalled);
    const ticket = document.createElement('span');
    applyTicket(ticket, info.ticket);
    const budget = document.createElement('span');
    applyBudget(budget, info);
    const loop = document.createElement('span');
    applyLoop(loop, info.loop);
    el.append(title, meta, state, stalled, ticket, budget, loop, progress);
    if (!pending) { // a queued agent has no terminal to expand yet
      const expand = document.createElement('button');
      bindText(expand, 'panel.expand');
      expand.addEventListener('click', () => { this.expanded = info.slug; this.update(this.lastMain!, this.lastAgents); });
      el.append(expand);
    }
    this.bars.set(info.slug, { el, state, progress, stalled, ticket, budget, loop, pending });
    return el;
  }
}
