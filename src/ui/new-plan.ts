// Minimal dialog left by Phase 6C (a folder and Create); Phase 6D owns this file and replaces it with the template dialog.
import type { ApiError, StateMessage } from '../shared/protocol';
import { api } from './api';
import { bindText } from './i18n-client';
import { errorText } from './new-agent';
import { focusElementFromUser } from './focus';
import { closeOverlay } from './settings';

export function openNewPlanDialog(_getState: () => StateMessage | undefined): void {
  const overlay = document.getElementById('overlay')!;
  const dialog = document.createElement('form');
  dialog.className = 'dialog';
  const title = document.createElement('h2');
  bindText(title, 'plans.new.title');
  const label = document.createElement('label');
  const text = document.createElement('span');
  bindText(text, 'plans.newFolder');
  const folder = document.createElement('input');
  folder.name = 'root';
  folder.autocomplete = 'off';
  label.append(text, folder);
  const error = document.createElement('div');
  error.className = 'form-error';
  const actions = document.createElement('div');
  actions.className = 'form-actions';
  const create = document.createElement('button');
  create.type = 'submit';
  bindText(create, 'plans.create');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  bindText(cancel, 'common.cancel');
  cancel.addEventListener('click', closeOverlay);
  actions.append(create, cancel);
  dialog.append(title, label, error, actions);
  dialog.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void api<ApiError | { name: string }>('/api/plans', { method: 'POST', body: { root: folder.value.trim() } }).then((res) => {
      if (res.status === 201) {
        closeOverlay();
        window.dispatchEvent(new CustomEvent('console-select-plan', { detail: (res.body as { name: string }).name }));
      }
      else error.textContent = errorText(res.body as ApiError);
    });
  });
  overlay.replaceChildren(dialog);
  overlay.hidden = false;
  focusElementFromUser(folder, 'user');
}
