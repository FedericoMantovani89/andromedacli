import type { ApiError } from '../shared/protocol';
import { api } from './api';
import { bindText, k } from './i18n-client';
import { errorText } from './new-agent';
import { closeOverlay } from './settings';

/**
 * The question after Save when a setting the sessions read only when they start has changed (bypass, guard mode, agent model). Yes asks
 * the server to restart them (the main resumes its conversation, the agents that were running are started again) and then loads the page
 * again, which starts from the splash; No just closes. It cannot make a newly installed program visible: the console never reads the PATH
 * from the system, so that needs the console itself started again from a new terminal.
 */
export function openRestartDialog(): void {
  const overlay = document.getElementById('overlay')!;
  const dialog = document.createElement('div');
  dialog.className = 'dialog restart-dialog';
  dialog.dataset.escape = '';
  const title = document.createElement('h2');
  bindText(title, 'options.restart.title');
  dialog.append(title);
  const note = document.createElement('p');
  note.className = 'settings-note';
  bindText(note, k('options.restart.settings'));
  dialog.append(note);
  const question = document.createElement('p');
  bindText(question, 'options.restart.question');
  const error = document.createElement('div');
  error.className = 'form-error';
  const actions = document.createElement('div');
  actions.className = 'form-actions';
  const no = document.createElement('button');
  no.type = 'button';
  no.name = 'restartNo';
  bindText(no, 'common.no');
  no.addEventListener('click', closeOverlay);
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.name = 'restartYes';
  bindText(yes, 'common.yes');
  yes.addEventListener('click', () => {
    yes.disabled = true;
    no.disabled = true;
    bindText(question, 'options.restart.working');
    void api<ApiError>('/api/restart', { method: 'POST' }).then((res) => {
      if (res.status === 200) { location.reload(); return; }
      error.textContent = errorText(res.body);
      bindText(question, 'options.restart.question');
      yes.disabled = false;
      no.disabled = false;
    }, () => { location.reload(); }); // the connection dropped while the sessions were restarting: the page loads again
  });
  actions.append(no, yes);
  dialog.append(question, error, actions);
  overlay.replaceChildren(dialog);
  overlay.hidden = false;
}
