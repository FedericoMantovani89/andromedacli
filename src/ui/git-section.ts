import type { ApiError, StateMessage } from '../shared/protocol';
import { api } from './api';
import { bindText } from './i18n-client';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
};

/**
 * What the project folder is for git, and the button that makes it a repository when it is not one (nothing starts git on its own).
 * Used by the Options, Git tab and by the optional Git step of the first-start wizard. `fail` shows a refused request and says whether
 * it was one; `heading` is added above the text when given.
 */
export function renderGitProject(state: StateMessage | undefined, fail: (res: { status: number; body: unknown }) => boolean, heading?: HTMLElement): HTMLElement {
  const box = el('div', 'options-git-project');
  if (heading) box.append(heading);
  const message = el('p', 'settings-note');
  box.append(message);
  if (!state) { bindText(message, 'common.notAvailable'); return box; }
  if (state.projectIsRepo) {
    if (state.repos.includes('')) bindText(message, 'options.git.isRepo');
    else bindText(message, 'options.git.holdsRepos', { repos: state.repos.join(', ') });
    return box;
  }
  bindText(message, 'options.git.notRepo');
  const init = el('button');
  init.type = 'button';
  init.name = 'gitInit';
  bindText(init, 'options.git.init');
  const help = el('p', 'settings-note');
  bindText(help, 'options.git.init.help');
  init.addEventListener('click', () => {
    init.disabled = true;
    void api<ApiError>('/api/projects/git-init', { method: 'POST' }).then((res) => {
      if (fail(res)) { init.disabled = false; return; }
      bindText(message, 'options.git.init.done');
      init.hidden = true;
      help.hidden = true;
    });
  });
  box.append(init, help);
  return box;
}
