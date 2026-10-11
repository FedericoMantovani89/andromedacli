import type { Activity } from '../shared/activity';
import { canArchive } from '../shared/archive';
import type { SessionInfo, StateMessage } from '../shared/protocol';
import { api } from './api';
import { STATE_KEYS, TICKET_KEYS } from './chips';
import { bindText, k } from './i18n-client';
import { closeOverlay } from './settings';
import { el } from './dom';

/** The agents the column shows: the archived ones are in the state in full, but only the archive list draws them. */
export const visibleAgents = (agents: SessionInfo[]): SessionInfo[] => agents.filter((a) => !a.archived);
export const archivedAgents = (agents: SessionInfo[]): SessionInfo[] => agents.filter((a) => a.archived);
/** The agents "Archive all finished" would archive now: the same rule the server applies. */
export const archivableAgents = (agents: SessionInfo[]): SessionInfo[] => agents.filter((a) => !a.archived && canArchive(a.state, a.ticket?.status));

/** The small button of a panel or bar header: shown only while the agent is finished-like (the server checks again). */
export function createArchiveButton(slug: string): HTMLButtonElement {
  const b = el('button');
  b.type = 'button';
  b.className = 'panel-archive';
  b.hidden = true;
  bindText(b, k('panel.archive'));
  b.addEventListener('mousedown', (ev) => ev.preventDefault()); // a button here must not take the keyboard
  b.addEventListener('click', (ev) => { ev.stopPropagation(); void api(`/api/agents/${slug}/archive`, { method: 'POST' }).catch(() => undefined); });
  return b;
}

export function syncArchiveButton(root: HTMLElement, state: Activity, ticket: SessionInfo['ticket']): void {
  const b = root.querySelector<HTMLElement>('.panel-archive');
  if (b) b.hidden = !canArchive(state, ticket?.status);
}

/** The open dialog's list and button, kept so a state push can refresh them without rebuilding the dialog. */
let open: { list: HTMLElement; all: HTMLButtonElement; finished: HTMLButtonElement; dialog: HTMLElement } | undefined;

const unarchive = (slug: string): Promise<unknown> => api(`/api/agents/${slug}/unarchive`, { method: 'POST' }).catch(() => undefined);

function paintRows(list: HTMLElement, archived: SessionInfo[]): void {
  if (archived.length === 0) {
    const empty = el('div', 'archive-empty');
    bindText(empty, k('archive.empty'));
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...archived.map((a) => {
    const row = el('div', 'archive-row');
    const name = el('span', 'archive-name');
    name.textContent = a.slug;
    const profile = el('span', 'archive-profile');
    profile.textContent = a.profile;
    const ticket = el('span', 'archive-ticket');
    const ticketKey = a.ticket ? TICKET_KEYS[a.ticket.status] : undefined;
    bindText(ticket, ticketKey ?? STATE_KEYS[a.state]);
    const when = el('span', 'archive-when');
    const at = a.archivedAt === undefined ? Number.NaN : Date.parse(a.archivedAt);
    if (Number.isFinite(at)) when.textContent = new Date(at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    else bindText(when, 'common.notAvailable');
    const restore = el('button');
    restore.type = 'button';
    bindText(restore, k('archive.unarchive'));
    restore.addEventListener('click', () => { void unarchive(a.slug); });
    row.append(name, profile, ticket, when, restore);
    return row;
  }));
}

/** Follows the state while the dialog is open: a restored agent leaves the list at once. */
export function refreshArchiveDialog(state: StateMessage): void {
  if (!open || !open.dialog.isConnected) { open = undefined; return; }
  const archived = archivedAgents(state.agents);
  paintRows(open.list, archived);
  open.all.disabled = archived.length === 0;
  const n = archivableAgents(state.agents).length;
  open.finished.disabled = n === 0;
  if (n === 0) open.dialog.querySelector('.archive-confirm')?.remove();
}

/** The archive list (a dialog like the other ones): who is archived, and a button to bring each one, or all, back. */
export function openArchiveDialog(getState: () => StateMessage | undefined): void {
  const overlay = document.getElementById('overlay')!;
  const dialog = el('div', 'dialog archive-dialog');
  dialog.dataset.escape = '';
  const title = el('h3');
  bindText(title, k('archive.title'));
  const list = el('div', 'archive-list');
  const actions = el('div', 'form-actions');
  const all = el('button');
  all.type = 'button';
  all.className = 'archive-all';
  bindText(all, k('archive.unarchiveAll'));
  all.addEventListener('click', () => {
    const slugs = archivedAgents(getState()?.agents ?? []).map((a) => a.slug);
    void Promise.all(slugs.map(unarchive));
  });
  const close = el('button');
  close.type = 'button';
  bindText(close, 'common.close');
  close.addEventListener('click', closeOverlay);
  const finished = el('button');
  finished.type = 'button';
  finished.className = 'archive-finished';
  bindText(finished, k('archive.archiveFinished'));
  finished.addEventListener('click', () => {
    dialog.querySelector('.archive-confirm')?.remove();
    const count = archivableAgents(getState()?.agents ?? []).length;
    if (count === 0) return;
    const line = el('div', 'archive-confirm');
    const text = el('span');
    bindText(text, 'archive.confirmFinished', { count });
    const yes = el('button');
    yes.type = 'button';
    yes.className = 'archive-confirm-yes';
    bindText(yes, 'archive.confirmYes');
    yes.addEventListener('click', () => { line.remove(); void api('/api/agents/archive-finished', { method: 'POST' }).catch(() => undefined); });
    const no = el('button');
    no.type = 'button';
    no.className = 'archive-confirm-no';
    bindText(no, 'common.cancel');
    no.addEventListener('click', () => line.remove());
    line.append(text, yes, no);
    actions.before(line);
  });
  actions.append(finished, all, close);
  dialog.append(title, list, actions);
  overlay.replaceChildren(dialog);
  overlay.hidden = false;
  open = { list, all, finished, dialog };
  const s = getState();
  if (s) refreshArchiveDialog(s);
}
