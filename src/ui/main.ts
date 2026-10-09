import type { HostInfo, StateMessage } from '../shared/protocol';
import { api, getSelectedProject, setSelectedProject, wsUrl } from './api';
import { openNewProjectDialog } from './new-project';
import { neighbourProject, openCloseProjectDialog, renderProjectTabs, titleWithWaiting } from './project-tabs';
import { bindText, initI18n, initI18nAnonymous, resolveLanguage } from './i18n-client';
import { createNewAgentControl } from './new-agent';
import { createQueueDrawer, queueIdFromHash } from './queue';
import { createRequestsDrawer } from './requests';
import { showBrowserNotification, titleWithCount } from './notify-browser';
import { startPresence } from './presence';
import type { NotifyMessage } from '../shared/notify';
import { createReader, type ReadingEntry } from './reader';
import { Workspace } from './panels';
import { closeOverlay, openSettings } from './settings';
import { renderStatusBar } from './statusbar';
import { openWizard } from './wizard';
import { runSplash } from './splash';
import { showWelcome } from './welcome';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let state: StateMessage | undefined;
/** The workspace of the project on screen; every project has its own (made on first view), the other ones stay hidden. */
let workspace: Workspace | undefined;
const workspaces = new Map<string, { ws: Workspace; el: HTMLElement }>();
/** A tab was just selected (a user action): its workspace is shown and takes the keyboard once its state arrives. */
let pendingShow = false;
let stateSocket: WebSocket | undefined;
const baseTitle = document.title;
let wizardShown = false;
const queueDrawer = createQueueDrawer($('drawer'));
const requestsDrawer = createRequestsDrawer($('requests'));
// The two drawers take the same place: opening one closes the other (the queue needs the user, it must never sit underneath).
const toggleQueue = (): void => { if (!queueDrawer.isOpen()) requestsDrawer.close(); queueDrawer.toggle(); };
const toggleRequests = (): void => { if (!requestsDrawer.isOpen()) queueDrawer.close(); requestsDrawer.toggle(); };
const reader = createReader($('reader'));
const listeners: ((s: StateMessage) => void)[] = [];

/** Other UI modules subscribe here; the shell owns the single /ws/ui connection. */
export function onState(cb: (s: StateMessage) => void): void {
  listeners.push(cb);
  if (state) cb(state);
}

function renderChrome(s: StateMessage): void {
  // An older server sends no list: this project alone, with its own queue.
  const projects = s.projects ?? [{ name: s.project.name, root: s.projectRoot, waiting: s.queue.length, mainStatus: s.main.status }];
  renderProjectTabs($('tabs'), projects, s.project.name, {
    select: (name) => selectProject(name),
    close: (name) => openCloseProjectDialog(name, projects.length <= 1),
    add: () => openNewProjectDialog(() => state),
  });
  document.title = titleWithWaiting(baseTitle, projects);
  bindText($('queue-btn'), 'header.queue', { count: s.queue.length });
  const live = (s.requests ?? []).filter((r) => r.state === 'open' || r.state === 'escalated').length;
  $('requests-btn').hidden = (s.requests ?? []).length === 0 && !requestsDrawer.isOpen();
  bindText($('requests-btn'), 'header.requests', { count: live });
  bindText($('settings-btn'), 'header.settings');
  renderStatusBar($('statusbar'), s);
  document.title = titleWithCount(document.title, s.queue.length); // the number of things waiting (6C replaces it with the all-projects total)
}

const SPLIT_KEY = 'console.split';

/** The draggable divider between main and the agents: sets the main column's share (clamped 20-80%), remembered per browser. Terminals refit through their ResizeObserver. */
function makeSplitHandle(ws: HTMLElement): HTMLElement {
  const handle = document.createElement('div');
  handle.className = 'split-handle';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  const set = (pct: number): number => {
    const p = Math.min(80, Math.max(20, pct));
    ws.style.setProperty('--split', `${p}fr`);
    ws.style.setProperty('--split-rest', `${100 - p}fr`);
    return p;
  };
  try {
    const saved = Number(localStorage.getItem(SPLIT_KEY));
    if (saved >= 20 && saved <= 80) set(saved);
  } catch { /* storage may be blocked: keep the default half */ }
  let current = 50;
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    ws.classList.add('resizing');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    const box = ws.getBoundingClientRect();
    if (box.width <= 0) return;
    current = set(((e.clientX - box.left) / box.width) * 100);
  });
  const end = (e: PointerEvent): void => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    handle.releasePointerCapture(e.pointerId);
    handle.classList.remove('dragging');
    ws.classList.remove('resizing');
    try { localStorage.setItem(SPLIT_KEY, String(current)); } catch { /* not remembered */ }
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', () => {
    current = set(50);
    try { localStorage.removeItem(SPLIT_KEY); } catch { /* ignore */ }
  });
  return handle;
}

/** Makes the workspace of a project the first time it is shown: its own pair of columns inside `#workspace`, hidden until selected. */
function createProjectWorkspace(s: StateMessage): { ws: Workspace; el: HTMLElement } {
  const el = document.createElement('div');
  el.className = 'project-ws';
  el.hidden = true;
  const mainCol = document.createElement('section');
  mainCol.className = 'project-main';
  const agentsCol = document.createElement('section');
  agentsCol.className = 'project-agents';
  el.append(mainCol, makeSplitHandle(el), agentsCol);
  $('workspace').append(el);
  const ws = new Workspace(mainCol, agentsCol, s.main.slug, s.project.name);
  ws.setNewAgentControl(createNewAgentControl(() => state?.profiles ?? [], () => ws.activate(ws.active), () => state?.repos ?? []));
  return { ws, el };
}

/** A tab was chosen (a click or Alt+arrow, so a user action): show that project, re-fit its terminals, give it the keyboard. */
function selectProject(name: string): void {
  if (getSelectedProject() === name) { workspace?.show(); return; }
  setSelectedProject(name);
  const known = workspaces.get(name);
  if (known) {
    for (const [n, e] of workspaces) e.el.hidden = n !== name;
    workspace = known.ws;
    known.ws.show();
  } else {
    pendingShow = true; // its workspace is made when the first state of the project arrives
  }
  connectState(); // the state socket follows the project on screen
}

function apply(s: StateMessage): void {
  const selected = getSelectedProject();
  if (selected !== undefined && selected !== s.project.name) return; // a late push of the project that was just left
  if (selected === undefined) setSelectedProject(s.project.name);
  const first = workspaces.size === 0;
  state = s;
  renderChrome(s);
  // A project closed (here or in another tab of the browser): its workspace and terminals go.
  const open = new Set((s.projects ?? [{ name: s.project.name }]).map((p) => p.name));
  for (const [name, e] of workspaces) {
    if (open.has(name)) continue;
    e.ws.dispose();
    e.el.remove();
    workspaces.delete(name);
  }
  let entry = workspaces.get(s.project.name);
  if (!entry) {
    entry = createProjectWorkspace(s);
    workspaces.set(s.project.name, entry);
  }
  for (const [name, e] of workspaces) e.el.hidden = name !== s.project.name;
  workspace = entry.ws;
  workspace.update(s.main, s.agents);
  queueDrawer.update(s.queue);
  requestsDrawer.update(s.requests ?? []);
  // A tab chosen by the user takes the keyboard once its workspace is on screen.
  if (pendingShow) { pendingShow = false; workspace.show(); }
  // Opening the console is the user's action, so main starts as the active input. Not while the first-start wizard is
  // on top: keys typed behind a dialog must not reach a hidden terminal; the focus returns when the dialog closes.
  if (first && !s.needsSetup) workspace.focusMainOnOpen();
  if (s.needsSetup && !wizardShown) {
    wizardShown = true;
    openWizard(() => state);
  }
  for (const cb of listeners) cb(s);
}

/** A refused token (for example after the server restarted) gets an explanation instead of a blank page. */
async function showUnauthorized(): Promise<void> {
  await initI18nAnonymous();
  const overlay = $('overlay');
  const dialog = document.createElement('div');
  dialog.className = 'dialog';
  const message = document.createElement('div');
  bindText(message, 'error.unauthorized');
  dialog.append(message);
  overlay.replaceChildren(dialog);
  overlay.hidden = false;
}

/** Opens the state socket of the project on screen (a socket still open for another project is closed first). */
function connectState(): void {
  const previous = stateSocket;
  if (previous) { stateSocket = undefined; previous.close(); }
  const ws = new WebSocket(wsUrl('/ws/ui'));
  stateSocket = ws;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as { type: string };
    if (msg.type === 'state') apply(msg as StateMessage);
    else if (msg.type === 'notify') showBrowserNotification(msg as NotifyMessage, state?.notifications?.config, document.hasFocus()); // no native toast: the browser fallback
    else window.dispatchEvent(new CustomEvent('console-message', { detail: msg })); // reading entries etc.
  };
  ws.onclose = () => {
    if (stateSocket !== ws) return; // replaced on purpose (another tab was chosen)
    // Reconnect, unless the server now refuses our token (it restarted with a new one) or our project is gone (it was closed).
    void api('/api/state').then(
      (r) => {
        if (r.status === 401) void showUnauthorized();
        else if (r.status === 404) { setSelectedProject(undefined); connectState(); }
        else setTimeout(connectState, 1000);
      },
      () => setTimeout(connectState, 1000),
    );
  };
}

window.addEventListener('overlayclosed', () => workspace?.activate(workspace.active));
window.addEventListener('console-open-reader', (ev) => { void reader.toggle((ev as CustomEvent<string>).detail); });
window.addEventListener('console-message', (ev) => {
  const msg = (ev as CustomEvent<{ type: string; slug?: string; entry?: ReadingEntry }>).detail;
  if (msg.type === 'reading' && msg.slug && msg.entry) reader.onEntry(msg.slug, msg.entry);
});

/** Escape closes a dialog that opted in with data-escape (options, new project, close project); the first-start wizard and installs do not. */
window.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape' || ev.altKey || ev.ctrlKey || ev.metaKey) return;
  const overlay = $('overlay');
  if (overlay.hidden || !overlay.querySelector('.dialog[data-escape]')) return;
  ev.preventDefault();
  closeOverlay();
}, true);

/** Alt+1 main, Alt+2..9 agents, Alt+Q the queue, Alt+L the read panel (SPEC 5.4). Ctrl+digit is reserved by browsers. */
window.addEventListener('keydown', (ev) => {
  if (!ev.altKey || ev.ctrlKey || ev.metaKey) return;
  const key = ev.key.toLowerCase();
  if (key === 'q') { ev.preventDefault(); toggleQueue(); return; }
  if (key === 'l') { ev.preventDefault(); if (workspace) void reader.toggle(workspace.active); return; }
  // Alt+Left / Alt+Right switch projects (Alt+Left is also the browser's "back": taken here).
  if (key === 'arrowleft' || key === 'arrowright') {
    ev.preventDefault();
    const next = neighbourProject(state?.projects ?? [], state?.project.name ?? '', key === 'arrowright' ? 1 : -1);
    if (next) selectProject(next);
    return;
  }
  const n = Number(ev.key);
  if (Number.isInteger(n) && n >= 1 && n <= 9) {
    ev.preventDefault();
    workspace?.activateByIndex(n - 1);
  }
}, true); // capture phase: xterm.js handles keys inside the terminal before they could bubble to window

// The "new project" dialog announces the project it made: opening it is a user action, so its tab is chosen.
window.addEventListener('console-select-project', (ev) => { selectProject((ev as CustomEvent<string>).detail); });

$('settings-btn').addEventListener('click', () => openSettings(() => state));
$('queue-btn').addEventListener('click', () => toggleQueue());
$('requests-btn').addEventListener('click', () => toggleRequests());

async function boot(): Promise<void> {
  // A console with no project open has no state to show: it asks for a project first (and reloads once there is one).
  const host = await api<HostInfo>('/api/host');
  if (host.status === 401) return showUnauthorized();
  if (host.status === 200 && host.body.projects.length === 0) {
    await initI18n(resolveLanguage(host.body.language, host.body.languages));
    showWelcome();
    return;
  }
  let res = await api<StateMessage>('/api/state');
  if (res.status === 404 && getSelectedProject() !== undefined) { // the project remembered by this tab is not open any more
    setSelectedProject(undefined);
    res = await api<StateMessage>('/api/state');
  }
  if (res.status === 401) return showUnauthorized();
  if (res.status !== 200) return;
  await initI18n(resolveLanguage(res.body.language, res.body.languages));
  apply(res.body);
  // A click on a notification opens the page at `#queue=<id>`: show that item (opening the drawer is not a focus move).
  const wanted = queueIdFromHash(location.hash);
  if (wanted) {
    requestsDrawer.close();
    queueDrawer.openOn(wanted);
    history.replaceState(null, '', location.pathname + location.search);
  }
  startPresence(() => state, () => workspace?.active ?? '', () => queueDrawer.isOpen());
  connectState();
}

runSplash();
void boot();
