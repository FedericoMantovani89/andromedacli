import type { PrereqResult, StateMessage } from '../shared/protocol';
import { api } from './api';
import { openOptions } from './options';
import { bindText, k, languageName, resolveLanguage, setLanguage } from './i18n-client';

/**
 * Language selector: "auto" plus every language the server has a bundle for (a new messages_xx file is enough).
 * Applies at runtime without a reload and saves the choice (SPEC 5.9, 22.2).
 */
export function createLanguageSelect(current: string, languages: readonly string[], onChange?: (value: string) => void): HTMLSelectElement {
  const select = document.createElement('select');
  const auto = document.createElement('option');
  auto.value = 'auto';
  bindText(auto, 'settings.language.auto');
  select.append(auto);
  for (const code of languages) {
    const o = document.createElement('option');
    o.value = code;
    o.textContent = languageName(code); // language names are shown in their own language
    select.append(o);
  }
  select.value = current;
  select.addEventListener('change', () => {
    void setLanguage(resolveLanguage(select.value, languages)).then(() => onChange?.(select.value));
  });
  return select;
}

/** Table of required tools with their status and a "check again" button (SPEC 29.3). */
export function renderPrereqTable(container: HTMLElement, results: PrereqResult[] | null): void {
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
    container.append(row);
  }
  const again = document.createElement('button');
  bindText(again, 'prereq.recheck');
  again.addEventListener('click', () => {
    void api<PrereqResult[]>('/api/prereq/recheck', { method: 'POST' }).then((res) => {
      if (res.status === 200) renderPrereqTable(container, res.body);
    });
  });
  container.append(again);
}

export function closeOverlay(): void {
  const overlay = document.getElementById('overlay')!;
  overlay.hidden = true;
  overlay.replaceChildren();
  // The user just closed a dialog (a click): the shell hands the keyboard back to the active terminal.
  window.dispatchEvent(new CustomEvent('overlayclosed'));
}

/** Opens the Options dialog (tabs: models, budget, git, guard, plans, language, prerequisites, plugins...; see options.ts). */
export function openSettings(getState: () => StateMessage | undefined): void {
  void openOptions(getState);
}
