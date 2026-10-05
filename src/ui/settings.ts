import type { ApiError, PrereqResult, StateMessage } from '../shared/protocol';
import { api } from './api';
import { errorText } from './new-agent';
import { openInstallDialog } from './install-dialog';
import { renderNotificationsTab } from './options-notifications';
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
    // A missing, outdated or unreadable tool can be installed from here, after the user has seen and approved the command (Phase 6F).
    const fixable = r.status === 'missing' || r.status === 'outdated' || r.status === 'error';
    const action = document.createElement(fixable ? 'button' : 'span');
    if (fixable) {
      bindText(action, r.status === 'missing' ? k('prereq.install') : k('prereq.update'));
      action.addEventListener('click', () => {
        openInstallDialog(r.id, () => {
          void api<PrereqResult[]>('/api/prereq/recheck', { method: 'POST' }).then((res) => {
            if (res.status === 200) renderPrereqTable(container, res.body);
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

/**
 * The settings that decide how new agents are launched: the permission bypass, the guard mode and the plan's test command.
 * The first two apply to sessions launched afterwards (running ones keep what they started with), and the dialog says so.
 */
function createAgentSettings(state: StateMessage | undefined): HTMLElement {
  const box = document.createElement('div');
  box.className = 'settings-agents';
  const error = document.createElement('div');
  error.className = 'form-error';
  const failed = (res: { status: number; body: unknown }): boolean => {
    if (res.status === 200) { error.textContent = ''; return false; }
    error.textContent = errorText(res.body as ApiError);
    return true;
  };

  const bypassRow = document.createElement('label');
  bypassRow.className = 'settings-switch';
  const bypass = document.createElement('input');
  bypass.type = 'checkbox';
  bypass.name = 'bypass';
  bypass.checked = state?.settings.bypassPermissions ?? false;
  const bypassText = document.createElement('span');
  bindText(bypassText, 'settings.bypass');
  bypassRow.append(bypass, bypassText);
  const warning = document.createElement('p');
  warning.className = 'settings-warning';
  bindText(warning, 'settings.bypass.warning');
  bypass.addEventListener('change', () => {
    const wanted = bypass.checked;
    void api<ApiError>('/api/config', { method: 'PUT', body: { agents: { bypassPermissions: wanted } } }).then((res) => {
      if (failed(res)) bypass.checked = !wanted; // not saved: the switch must not show a state that is not real
    });
  });

  const guardRow = document.createElement('label');
  const guardText = document.createElement('span');
  bindText(guardText, 'settings.guardMode');
  const guard = document.createElement('select');
  guard.name = 'guardMode';
  for (const mode of ['enforce', 'shadow'] as const) {
    const o = document.createElement('option');
    o.value = mode;
    bindText(o, mode === 'enforce' ? k('settings.guardMode.enforce') : k('settings.guardMode.shadow'));
    guard.append(o);
  }
  guard.value = state?.settings.guardMode ?? 'enforce';
  let savedMode = guard.value;
  guard.addEventListener('change', () => {
    const wanted = guard.value;
    void api<ApiError>('/api/config', { method: 'PUT', body: { guard: { mode: wanted } } }).then((res) => {
      if (failed(res)) guard.value = savedMode;
      else savedMode = wanted;
    });
  });
  guardRow.append(guardText, guard);

  const applies = document.createElement('p');
  applies.className = 'settings-note';
  bindText(applies, 'settings.appliesToNew');

  const squashRow = document.createElement('label');
  squashRow.className = 'settings-switch';
  const squash = document.createElement('input');
  squash.type = 'checkbox';
  squash.name = 'squash';
  squash.checked = state?.plan.squash !== false; // one commit per merged ticket unless the plan says otherwise
  const squashText = document.createElement('span');
  bindText(squashText, 'settings.squash');
  squashRow.append(squash, squashText);
  const squashHelp = document.createElement('p');
  squashHelp.className = 'settings-note';
  bindText(squashHelp, 'settings.squash.help');
  squash.addEventListener('change', () => {
    const wanted = squash.checked;
    void api<ApiError>('/api/plan', { method: 'PUT', body: { squash: wanted } }).then((res) => {
      if (failed(res)) squash.checked = !wanted;
    });
  });

  const testForm = document.createElement('form');
  testForm.className = 'settings-test';
  const testLabel = document.createElement('label');
  const testText = document.createElement('span');
  bindText(testText, 'settings.testCommand');
  const test = document.createElement('input');
  test.name = 'testCommand';
  test.autocomplete = 'off';
  test.value = state?.plan.testCommand ?? '';
  testLabel.append(testText, test);
  const save = document.createElement('button');
  save.type = 'submit';
  bindText(save, 'common.save');
  const help = document.createElement('p');
  help.className = 'settings-note';
  bindText(help, 'settings.testCommand.help');
  testForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void api<ApiError>('/api/plan', { method: 'PUT', body: { testCommand: test.value } }).then((res) => { failed(res); });
  });
  testForm.append(testLabel, save, help);

  box.append(bypassRow, warning, guardRow, applies, squashRow, squashHelp, testForm, error);
  return box;
}

/** Opens the settings dialog (language, how agents are launched, prerequisites). */
export function openSettings(getState: () => StateMessage | undefined): void {
  const overlay = document.getElementById('overlay')!;
  const state = getState();
  const dialog = document.createElement('div');
  dialog.className = 'dialog';

  const title = document.createElement('h2');
  bindText(title, 'settings.title');

  const langRow = document.createElement('label');
  const langText = document.createElement('span');
  bindText(langText, 'settings.language');
  const select = createLanguageSelect(state?.language ?? 'auto', state?.languages ?? [], (value) => {
    void api('/api/config', { method: 'PUT', body: { language: value } });
  });
  langRow.append(langText, select);

  const agentsTitle = document.createElement('h2');
  bindText(agentsTitle, 'settings.agents');
  const agentSettings = createAgentSettings(state);

  const prereqTitle = document.createElement('h2');
  bindText(prereqTitle, 'settings.prerequisites');
  const table = document.createElement('div');
  renderPrereqTable(table, state?.prereq ?? null);

  const close = document.createElement('button');
  bindText(close, 'common.close');
  close.addEventListener('click', closeOverlay);

  // Phase 6B: until the tabbed Options dialog exists, notifications are one more section here.
  const notifyTitle = document.createElement('h2');
  bindText(notifyTitle, 'settings.notifications');
  const notifyBox = document.createElement('div');
  if (state) renderNotificationsTab(notifyBox, state);

  dialog.append(title, langRow, agentsTitle, agentSettings, notifyTitle, notifyBox, prereqTitle, table, close);
  overlay.replaceChildren(dialog);
  overlay.hidden = false;
}
