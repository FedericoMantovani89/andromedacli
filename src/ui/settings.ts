import type { PrereqResult, StateMessage } from '../shared/protocol';
import { api } from './api';
import { openOptions } from './options';
import { openInstallDialog } from './install-dialog';
import { bindText, k, languageName, resolveLanguage, setLanguage } from './i18n-client';

/**
 * Language selector: every language the server has a bundle for (a new messages_xx file is enough). There is no "browser language"
 * entry: a browser in a language with no bundle would get English anyway, and the user's choice must be one that exists.
 * Applies at runtime without a reload and saves the choice (SPEC 5.9, 22.2).
 */
export function createLanguageSelect(current: string, languages: readonly string[], onChange?: (value: string) => void): HTMLSelectElement {
  const select = document.createElement('select');
  for (const code of languages) {
    const o = document.createElement('option');
    o.value = code;
    o.textContent = languageName(code); // language names are shown in their own language
    select.append(o);
  }
  // A saved "auto" (an older configuration) or a language whose bundle is gone shows English.
  select.value = languages.includes(current) ? current : languages.includes('en') ? 'en' : (languages[0] ?? '');
  select.addEventListener('change', () => {
    void setLanguage(resolveLanguage(select.value, languages)).then(() => onChange?.(select.value));
  });
  return select;
}

/**
 * Table of required tools with their status and a "check again" button (SPEC 29.3). The button goes under the table, centred, or into
 * `recheckHost` when the caller has a place for it (the wizard puts it between Back and Next).
 */
export function renderPrereqTable(container: HTMLElement, results: PrereqResult[] | null, recheckHost?: HTMLElement): void {
  container.replaceChildren();
  for (const r of results ?? []) {
    const row = document.createElement('div');
    row.className = 'prereq-row';
    const name = document.createElement('span');
    bindText(name, `prereq.${r.id}`);
    const status = document.createElement('span');
    status.className = `prereq-${r.status}`;
    bindText(status, `prereq.status.${r.status}`);
    const detail = document.createElement('span');
    detail.textContent = r.version ?? '';
    const need = document.createElement('span');
    bindText(need, r.required ? k('prereq.required') : k('prereq.optional'));
    row.append(name, status, detail, need);
    // A missing, outdated or unreadable tool can be installed from here, after the user has seen and approved the command (Phase 6F).
    const fixable = r.status === 'missing' || r.status === 'outdated' || r.status === 'error';
    const action = document.createElement(fixable ? 'button' : 'span');
    if (fixable) {
      bindText(action, r.status === 'missing' ? k('prereq.install') : k('prereq.update'));
      action.addEventListener('click', () => {
        openInstallDialog(r.id, () => {
          void api<PrereqResult[]>('/api/prereq/recheck', { method: 'POST' }).then((res) => {
            if (res.status === 200) renderPrereqTable(container, res.body, recheckHost);
          });
        });
      });
    }
    row.append(action);
    container.append(row);
  }
  const again = document.createElement('button');
  bindText(again, 'prereq.recheck');
  again.addEventListener('click', () => {
    void api<PrereqResult[]>('/api/prereq/recheck', { method: 'POST' }).then((res) => {
      if (res.status === 200) renderPrereqTable(container, res.body, recheckHost);
    });
  });
  if (recheckHost) { recheckHost.replaceChildren(again); return; }
  const centre = document.createElement('div');
  centre.className = 'prereq-recheck';
  centre.append(again);
  container.append(centre);
}

export function closeOverlay(): void {
  const overlay = document.getElementById('overlay')!;
  overlay.hidden = true;
  overlay.replaceChildren();
  // The user just closed a dialog (a click): the shell hands the keyboard back to the active terminal.
  window.dispatchEvent(new CustomEvent('overlayclosed'));
}

/** Opens the Options dialog (tabs: models, budget, git, guard, projects, language, prerequisites, plugins...; see options.ts). */
export function openSettings(getState: () => StateMessage | undefined): void {
  void openOptions(getState);
}
