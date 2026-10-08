import type { ApiError } from '../shared/protocol';
import { api } from './api';
import { bindText, k } from './i18n-client';
import { errorText } from './new-agent';
import { closeOverlay } from './settings';

/** Why a restart is offered: a setting the sessions read only when they start, and/or a program installed that they do not see yet. */
export interface RestartReasons { settings: boolean; programs: boolean }

/**
 * The question after Save when something needs the sessions to start again. Yes asks the server to restart them (the main resumes its
 * conversation, the agents that were running are started again) and then loads the page again, which starts from the splash; No just closes.
 */
export function openRestartDialog(reasons: RestartReasons, o: { over?: boolean } = {}): void {
  const overlay = document.getElementById('overlay')!;
  // `over`: asked from inside the Options dialog, which must stay as it is (its unsaved changes live there). The question goes on a layer
  // above it; No and Escape remove only that layer.
  const layer = o.over ? document.createElement('div') : undefined;
  if (layer) layer.className = 'restart-layer';
  const dismiss = (): void => {
    if (!layer) { closeOverlay(); return; }
    window.removeEventListener('keydown', onEscape, true);
    layer.remove();
  };
  function onEscape(ev: KeyboardEvent): void {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    dismiss();
  }
  if (layer) window.addEventListener('keydown', onEscape, true);
  const dialog = document.createElement('div');
  dialog.className = 'dialog restart-dialog';
  if (!layer) dialog.dataset.escape = '';
  const title = document.createElement('h2');
  bindText(title, 'options.restart.title');
  dialog.append(title);
  const addNote = (key: string): void => {
    const p = document.createElement('p');
    p.className = 'settings-note';
    bindText(p, key);
    dialog.append(p);
  };
  if (reasons.settings) addNote(k('options.restart.settings'));
  if (reasons.programs) addNote(k('options.restart.programs'));
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
  no.addEventListener('click', dismiss);
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
  if (layer) { layer.append(dialog); overlay.append(layer); return; }
  overlay.replaceChildren(dialog);
  overlay.hidden = false;
}
