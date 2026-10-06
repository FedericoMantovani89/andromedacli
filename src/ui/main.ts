import type { HostInfo, StateMessage } from '../shared/protocol';
import { api, getSelectedPlan, setSelectedPlan, wsUrl } from './api';
import { openNewPlanDialog } from './new-plan';
import { neighbourPlan, openClosePlanDialog, renderPlanTabs, titleWithWaiting } from './plan-tabs';
import { bindText, initI18n, initI18nAnonymous, resolveLanguage } from './i18n-client';
import { createNewAgentControl } from './new-agent';
import { createQueueDrawer, queueIdFromHash } from './queue';
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
/** The workspace of the plan on screen; every plan has its own (made on first view), the other ones stay hidden. */
let workspace: Workspace | undefined;
const workspaces = new Map<string, { ws: Workspace; el: HTMLElement }>();
/** A tab was just selected (a user action): its workspace is shown and takes the keyboard once its state arrives. */
let pendingShow = false;
let stateSocket: WebSocket | undefined;
const baseTitle = document.title;
let wizardShown = false;
const queueDrawer = createQueueDrawer($('drawer'));
const reader = createReader($('reader'));
const listeners: ((s: StateMessage) => void)[] = [];

/** Other UI modules subscribe here; the shell owns the single /ws/ui connection. */
export function onState(cb: (s: StateMessage) => void): void {
  listeners.push(cb);
  if (state) cb(state);
}

function renderChrome(s: StateMessage): void {
  // An older server sends no list: this plan alone, with its own queue.
  const plans = s.plans ?? [{ name: s.plan.name, root: s.planRoot, waiting: s.queue.length, mainStatus: s.main.status }];
  renderPlanTabs($('tabs'), plans, s.plan.name, {
    select: (name) => selectPlan(name),
    close: (name) => openClosePlanDialog(name),
    add: () => openNewPlanDialog(() => state),
  });
  document.title = titleWithWaiting(baseTitle, plans);
  bindText($('queue-btn'), 'header.queue', { count: s.queue.length });
  bindText($('settings-btn'), 'header.settings');
  renderStatusBar($('statusbar'), s);
  document.title = titleWithCount(document.title, s.queue.length); // the number of things waiting (6C replaces it with the all-plans total)
}

/** Makes the workspace of a plan the first time it is shown: its own pair of columns inside `#workspace`, hidden until selected. */
function createPlanWorkspace(s: StateMessage): { ws: Workspace; el: HTMLElement } {
  const el = document.createElement('div');
  el.className = 'plan-ws';
  el.hidden = true;
  const mainCol = document.createElement('section');
  mainCol.className = 'plan-main';
  const agentsCol = document.createElement('section');
  agentsCol.className = 'plan-agents';
  el.append(mainCol, agentsCol);
  $('workspace').append(el);
  const ws = new Workspace(mainCol, agentsCol, s.main.slug, s.plan.name);
  ws.setNewAgentControl(createNewAgentControl(() => state?.profiles ?? [], () => ws.activate(ws.active)));
  return { ws, el };
}

/** A tab was chosen (a click or Alt+arrow, so a user action): show that plan, re-fit its terminals, give it the keyboard. */
function selectPlan(name: string): void {
  if (getSelectedPlan() === name) { workspace?.show(); return; }
  setSelectedPlan(name);
  const known = workspaces.get(name);
  if (known) {
    for (const [n, e] of workspaces) e.el.hidden = n !== name;
    workspace = known.ws;
    known.ws.show();
  } else {
    pendingShow = true; // its workspace is made when the first state of the plan arrives
  }
  connectState(); // the state socket follows the plan on screen
}

function apply(s: StateMessage): void {
  const selected = getSelectedPlan();
  if (selected !== undefined && selected !== s.plan.name) return; // a late push of the plan that was just left
  if (selected === undefined) setSelectedPlan(s.plan.name);
  const first = workspaces.size === 0;
  state = s;
  renderChrome(s);
  // A plan closed (here or in another tab of the browser): its workspace and terminals go.
  const open = new Set((s.plans ?? [{ name: s.plan.name }]).map((p) => p.name));
  for (const [name, e] of workspaces) {
    if (open.has(name)) continue;
    e.ws.dispose();
    e.el.remove();
    workspaces.delete(name);
  }
  let entry = workspaces.get(s.plan.name);
  if (!entry) {
    entry = createPlanWorkspace(s);
    workspaces.set(s.plan.name, entry);
  }
  for (const [name, e] of workspaces) e.el.hidden = name !== s.plan.name;
  workspace = entry.ws;
  workspace.update(s.main, s.agents);
  queueDrawer.update(s.queue);
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

/** Opens the state socket of the plan on screen (a socket still open for another plan is closed first). */
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
    // Reconnect, unless the server now refuses our token (it restarted with a new one) or our plan is gone (it was closed).
    void api('/api/state').then(
      (r) => {
        if (r.status === 401) void showUnauthorized();
        else if (r.status === 404) { setSelectedPlan(undefined); connectState(); }
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

/** Escape closes a dialog that opted in with data-escape (options, new plan, close plan); the first-start wizard and installs do not. */
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
  if (key === 'q') { ev.preventDefault(); queueDrawer.toggle(); return; }
  if (key === 'l') { ev.preventDefault(); if (workspace) void reader.toggle(workspace.active); return; }
  // Alt+Left / Alt+Right switch plans (Alt+Left is also the browser's "back": taken here).
  if (key === 'arrowleft' || key === 'arrowright') {
    ev.preventDefault();
    const next = neighbourPlan(state?.plans ?? [], state?.plan.name ?? '', key === 'arrowright' ? 1 : -1);
    if (next) selectPlan(next);
    return;
  }
  const n = Number(ev.key);
  if (Number.isInteger(n) && n >= 1 && n <= 9) {
    ev.preventDefault();
    workspace?.activateByIndex(n - 1);
  }
}, true); // capture phase: xterm.js handles keys inside the terminal before they could bubble to window

// The "new plan" dialog announces the plan it made: opening it is a user action, so its tab is chosen.
window.addEventListener('console-select-plan', (ev) => { selectPlan((ev as CustomEvent<string>).detail); });

$('settings-btn').addEventListener('click', () => openSettings(() => state));
$('queue-btn').addEventListener('click', () => queueDrawer.toggle());

async function boot(): Promise<void> {
  // A console with no plan open has no state to show: it asks for a project first (and reloads once there is one).
  const host = await api<HostInfo>('/api/host');
  if (host.status === 401) return showUnauthorized();
  if (host.status === 200 && host.body.plans.length === 0) {
    await initI18n(resolveLanguage(host.body.language, host.body.languages));
    showWelcome();
    return;
  }
  let res = await api<StateMessage>('/api/state');
  if (res.status === 404 && getSelectedPlan() !== undefined) { // the plan remembered by this tab is not open any more
    setSelectedPlan(undefined);
    res = await api<StateMessage>('/api/state');
  }
  if (res.status === 401) return showUnauthorized();
  if (res.status !== 200) return;
  await initI18n(resolveLanguage(res.body.language, res.body.languages));
  apply(res.body);
  // A click on a notification opens the page at `#queue=<id>`: show that item (opening the drawer is not a focus move).
  const wanted = queueIdFromHash(location.hash);
  if (wanted) {
    queueDrawer.openOn(wanted);
    history.replaceState(null, '', location.pathname + location.search);
  }
  startPresence(() => state, () => workspace?.active ?? '', () => queueDrawer.isOpen());
  connectState();
}

runSplash();
void boot();
