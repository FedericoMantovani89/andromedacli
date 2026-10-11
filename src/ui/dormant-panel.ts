import type { SessionInfo } from '../shared/protocol';
import { api } from './api';
import { STATE_KEYS } from './chips';
import { bindText } from './i18n-client';
import { errorText } from './new-agent';

/** How many of the agent's last entries the panel prints. */
const MAX_ENTRIES = 6;

/**
 * The expanded panel of a dormant agent. It has no process, so it has no terminal: it prints what the agent last said (the entries of the
 * read panel, in full, not the cut line of the bar) so the user can read it before waking the agent, and has the Wake up button.
 */
export function createDormantPanel(info: SessionInfo): HTMLElement {
  const root = document.createElement('div');
  root.className = 'panel panel-dormant';

  const header = document.createElement('div');
  header.className = 'panel-header';
  const title = document.createElement('span');
  title.className = 'panel-title';
  title.textContent = info.slug; // the slug is data
  const meta = document.createElement('span');
  meta.className = 'panel-meta';
  meta.textContent = info.profile;
  const state = document.createElement('span');
  state.className = `panel-state ${info.state}`;
  bindText(state, STATE_KEYS[info.state]);
  const error = document.createElement('span');
  error.className = 'form-error';
  const wake = document.createElement('button');
  wake.type = 'button';
  wake.className = 'panel-wake';
  bindText(wake, 'panel.wake');
  wake.addEventListener('mousedown', (ev) => ev.preventDefault()); // a button here must not take the keyboard
  wake.addEventListener('click', () => {
    wake.disabled = true;
    error.textContent = '';
    void api<{ code?: string }>(`/api/agents/${info.slug}/wake`, { method: 'POST' }).then((r) => {
      if (r.status === 200) return; // the next state push shows it starting or queued
      wake.disabled = false;
      error.textContent = errorText({ code: r.body?.code ?? 'generic' });
    }).catch(() => { wake.disabled = false; });
  });
  header.append(title, meta, state, error, wake);

  const body = document.createElement('div');
  body.className = 'panel-dormant-body';
  const none = document.createElement('span');
  bindText(none, 'common.notAvailable'); // no data: "n/a", never an empty box
  body.append(none);
  void api<{ entries?: { text?: string }[] }>(`/api/reading/${info.slug}`).then((r) => {
    const texts = (r.status === 200 ? r.body?.entries ?? [] : []).map((e) => e.text ?? '').filter((t) => t.trim() !== '').slice(-MAX_ENTRIES);
    if (texts.length === 0) return;
    body.replaceChildren(...texts.map((text) => {
      const entry = document.createElement('div');
      entry.className = 'panel-dormant-entry';
      entry.textContent = text; // the agent's own words: data, never markup
      return entry;
    }));
    body.scrollTop = body.scrollHeight;
  }).catch(() => undefined);

  root.append(header, body);
  return root;
}
