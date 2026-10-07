import type { ApiError, ProjectTab } from '../shared/protocol';
import { api } from './api';
import { bindText } from './i18n-client';
import { errorText } from './new-agent';
import { closeOverlay } from './settings';

export interface TabHandlers {
  select(name: string): void;
  close(name: string): void;
  add(): void;
}

/**
 * One tab per open project (the selected one `current`, a dot class `attention` while that project's queue is not empty), a small close
 * button after each, then the "+ project" button. The nodes are replaced on every push: a tab button never needs to keep the keyboard.
 */
export function renderProjectTabs(tabs: HTMLElement, projects: ProjectTab[], selected: string, h: TabHandlers): void {
  tabs.replaceChildren();
  for (const p of projects) {
    const tab = document.createElement('button');
    const classes = ['tab'];
    if (p.name === selected) classes.push('current');
    if (p.waiting > 0) classes.push('attention');
    tab.className = classes.join(' ');
    tab.textContent = p.name; // project name is data, not UI text
    tab.dataset.project = p.name;
    tab.addEventListener('click', () => h.select(p.name));
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.dataset.project = p.name;
    bindText(close, 'projects.close');
    close.addEventListener('click', () => h.close(p.name));
    tabs.append(tab, close);
  }
  const add = document.createElement('button');
  add.className = 'tab';
  bindText(add, 'tabs.newProject');
  add.addEventListener('click', () => h.add());
  tabs.append(add);
}

/** The page title with a `(n) ` prefix while questions wait in any project (n is the total over all projects). */
export function titleWithWaiting(base: string, projects: ProjectTab[]): string {
  const total = projects.reduce((n, p) => n + p.waiting, 0);
  return total > 0 ? `(${total}) ${base}` : base;
}

/** The project next to `selected` in the given direction, wrapping around; undefined when there is nowhere to go. */
export function neighbourProject(projects: ProjectTab[], selected: string, direction: 1 | -1): string | undefined {
  if (projects.length < 2) return undefined;
  const i = projects.findIndex((p) => p.name === selected);
  return projects[(Math.max(i, 0) + direction + projects.length) % projects.length]!.name;
}

/**
 * Asks before closing a project (its running sessions end; nothing is deleted on disk unless the box is ticked: then the project's worktrees,
 * branches and `.console` go too and the project opens again as new). Closing the last project leaves the welcome screen, which needs a reload.
 */
export function openCloseProjectDialog(name: string, last = false): void {
  const overlay = document.getElementById('overlay')!;
  const dialog = document.createElement('div');
  dialog.className = 'dialog';
  dialog.dataset.escape = '';
  const message = document.createElement('div');
  bindText(message, 'projects.close.confirm', { name });
  const purgeRow = document.createElement('label');
  purgeRow.className = 'settings-switch';
  const purge = document.createElement('input');
  purge.type = 'checkbox';
  purge.name = 'purge';
  const purgeText = document.createElement('span');
  bindText(purgeText, 'projects.close.purge');
  purgeRow.append(purge, purgeText);
  const error = document.createElement('div');
  error.className = 'form-error';
  const actions = document.createElement('div');
  actions.className = 'form-actions';
  const yes = document.createElement('button');
  bindText(yes, 'projects.close.do');
  yes.addEventListener('click', () => {
    void api<ApiError | { name: string }>(`/api/projects/${encodeURIComponent(name)}${purge.checked ? '?purge=1' : ''}`, { method: 'DELETE' }).then((res) => {
      if (res.status === 200) { closeOverlay(); if (last) location.reload(); }
      else error.textContent = errorText(res.body as ApiError);
    });
  });
  const cancel = document.createElement('button');
  bindText(cancel, 'common.cancel');
  cancel.addEventListener('click', closeOverlay);
  actions.append(yes, cancel);
  dialog.append(message, purgeRow, error, actions);
  overlay.replaceChildren(dialog);
  overlay.hidden = false;
}
