import type { StateMessage } from '../shared/protocol';
import { api, wsUrl } from './api';
import { bindText, initI18n, initI18nAnonymous, resolveLanguage } from './i18n-client';
import { createNewAgentControl } from './new-agent';
import { createQueueDrawer } from './queue';
import { createReader, type ReadingEntry } from './reader';
import { Workspace } from './panels';
import { openSettings } from './settings';
import { renderStatusBar } from './statusbar';
import { openWizard } from './wizard';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let state: StateMessage | undefined;
let workspace: Workspace | undefined;
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
  const tabs = $('tabs');
  tabs.replaceChildren();
  const tab = document.createElement('button');
  tab.className = s.queue.length > 0 ? 'tab current attention' : 'tab current'; // a dot while something waits for the user
  tab.textContent = s.plan.name; // plan name is data, not UI text
  const add = document.createElement('button');
  add.className = 'tab';
  add.disabled = true; // multiple plans arrive in Phase 6
  bindText(add, 'tabs.newPlan');
  tabs.append(tab, add);
  bindText($('queue-btn'), 'header.queue', { count: s.queue.length });
  bindText($('settings-btn'), 'header.settings');
  renderStatusBar($('statusbar'), s);
}

function apply(s: StateMessage): void {
  const first = !workspace;
  state = s;
  renderChrome(s);
  if (!workspace) {
    workspace = new Workspace($('main-col'), $('agents-col'), s.main.slug);
    workspace.setNewAgentControl(
      createNewAgentControl(() => state?.profiles ?? [], () => workspace?.activate(workspace.active)),
    );
  }
  workspace.update(s.main, s.agents);
  queueDrawer.update(s.queue);
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

function connectState(): void {
  const ws = new WebSocket(wsUrl('/ws/ui'));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as { type: string };
    if (msg.type === 'state') apply(msg as StateMessage);
    else window.dispatchEvent(new CustomEvent('console-message', { detail: msg })); // reading entries etc.
  };
  ws.onclose = () => {
    // Reconnect, unless the server now refuses our token (it restarted with a new one).
    void api('/api/state').then(
      (r) => { if (r.status === 401) void showUnauthorized(); else setTimeout(connectState, 1000); },
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

/** Alt+1 main, Alt+2..9 agents, Alt+Q the queue, Alt+L the read panel (SPEC 5.4). Ctrl+digit is reserved by browsers. */
window.addEventListener('keydown', (ev) => {
  if (!ev.altKey || ev.ctrlKey || ev.metaKey) return;
  const key = ev.key.toLowerCase();
  if (key === 'q') { ev.preventDefault(); queueDrawer.toggle(); return; }
  if (key === 'l') { ev.preventDefault(); if (workspace) void reader.toggle(workspace.active); return; }
  const n = Number(ev.key);
  if (Number.isInteger(n) && n >= 1 && n <= 9) {
    ev.preventDefault();
    workspace?.activateByIndex(n - 1);
  }
}, true); // capture phase: xterm.js handles keys inside the terminal before they could bubble to window

$('settings-btn').addEventListener('click', () => openSettings(() => state));
$('queue-btn').addEventListener('click', () => queueDrawer.toggle());

async function boot(): Promise<void> {
  const res = await api<StateMessage>('/api/state');
  if (res.status === 401) return showUnauthorized();
  if (res.status !== 200) return;
  await initI18n(resolveLanguage(res.body.language, res.body.languages));
  apply(res.body);
  connectState();
}

void boot();
