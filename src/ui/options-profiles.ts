import type { ApiError } from '../shared/protocol';
import { api } from './api';
import { bindText, k, t } from './i18n-client';
import { errorText } from './new-agent';

/** What `GET /api/profiles` returns for one profile (the user's layer, plus where the version in force comes from). */
interface ProfileRow {
  name: string; description: string; model?: string; body: string; readOnly: boolean; budgetTokens?: number;
  source: 'project' | 'user' | 'shipped'; shipped: boolean; userFile: boolean; projectOverrides: boolean;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
};
const note = (key: string, params?: Record<string, string | number>): HTMLElement => {
  const p = el('p', 'settings-note');
  bindText(p, key, params);
  return p;
};
const button = (name: string, key: string): HTMLButtonElement => {
  const b = el('button');
  b.type = 'button';
  b.name = name;
  bindText(b, key);
  return b;
};

/**
 * The Profiles tab (SPEC 11): the profiles of the user (the config folder), shipped ones edited as a copy. Unlike the other tabs these are
 * actions, like "apply template": each one is sent when its own button is pressed, not by the dialog's Save. A change applies to the
 * agents launched afterwards.
 */
export function renderProfilesTab(box: HTMLElement, folder: string, editing: (on: boolean) => void): void {
  const error = el('div', 'form-error');
  const body = el('div', 'options-profiles');
  box.append(body, error);

  const run = async (res: Promise<{ status: number; body: unknown }>): Promise<boolean> => {
    const r = await res;
    error.textContent = r.status === 200 ? '' : errorText(r.body as ApiError);
    return r.status === 200;
  };

  const showList = async (): Promise<void> => {
    const res = await api<ProfileRow[]>('/api/profiles');
    if (res.status !== 200) { error.textContent = errorText(res.body as unknown as ApiError); return; }
    editing(false);
    body.replaceChildren();
    if (box.parentElement) box.parentElement.scrollTop = 0;
    const top = el('div', 'options-profiles-top options-profile-bar');
    const add = button('newProfile', k('options.profiles.new'));
    add.addEventListener('click', () => showForm(undefined));
    top.append(add);
    body.append(top);
    for (const p of res.body) {
      const row = el('div', 'options-profile-row');
      const text = el('div', 'options-profile-text');
      const name = el('strong');
      name.textContent = p.name;
      const desc = el('span', 'settings-note');
      desc.textContent = p.description;
      text.append(name, desc);
      const origin = el('span', 'settings-note');
      bindText(origin, p.source === 'project' ? k('options.profiles.source.project') : p.userFile && p.shipped ? k('options.profiles.modified') : p.userFile ? k('options.profiles.source.user') : k('options.profiles.source.shipped'));
      const actions = el('div', 'options-profile-actions');
      const editable = p.source !== 'project' || p.userFile || p.shipped; // a profile only the project has is not the user's to edit
      if (editable) {
        const edit = button('editProfile', k('options.profiles.edit'));
        edit.dataset.profile = p.name;
        edit.addEventListener('click', () => showForm(p));
        actions.append(edit);
      }
      if (p.userFile) {
        const drop = button(p.shipped ? 'restoreProfile' : 'deleteProfile', p.shipped ? k('options.profiles.restoreOne') : k('options.profiles.delete'));
        drop.dataset.profile = p.name;
        drop.addEventListener('click', () => {
          if (!window.confirm(t(p.shipped ? k('options.profiles.confirmRestoreOne') : k('options.profiles.confirmDelete'), { name: p.name }))) return;
          void run(api(`/api/profiles/${encodeURIComponent(p.name)}`, { method: 'DELETE' })).then((ok) => { if (ok) void showList(); });
        });
        actions.append(drop);
      }
      row.append(text, origin, actions);
      if (p.projectOverrides) row.append(note(k('options.profiles.projectOverrides')));
      body.append(row);
    }
    const restore = button('restoreAllProfiles', k('options.profiles.restoreAll'));
    restore.addEventListener('click', () => {
      if (!window.confirm(t(k('options.profiles.confirmRestoreAll')))) return;
      void run(api('/api/profiles/restore', { method: 'POST' })).then((ok) => { if (ok) void showList(); });
    });
    body.append(restore, note(k('options.profiles.appliesLater')), note(k('options.profiles.folder'), { path: folder }));
  };

  const showForm = (existing: ProfileRow | undefined): void => {
    error.textContent = '';
    editing(true);
    body.replaceChildren();
    if (box.parentElement) box.parentElement.scrollTop = 0;
    const field = <T extends HTMLElement>(labelKey: string, input: T, helpKey?: string): HTMLElement => {
      const label = el('label', 'options-field');
      const span = el('span');
      bindText(span, labelKey);
      label.append(span, input);
      if (!helpKey) return label;
      const wrap = el('div', 'options-field-wrap');
      wrap.append(label, note(helpKey));
      return wrap;
    };
    const name = el('input');
    name.name = 'profileName';
    name.autocomplete = 'off';
    name.maxLength = 40;
    name.value = existing?.name ?? '';
    name.disabled = existing !== undefined; // the name is the file: a rename would be a new profile
    const description = el('input');
    description.name = 'profileDescription';
    description.autocomplete = 'off';
    description.maxLength = 200;
    description.value = existing?.description ?? '';
    const model = el('select');
    model.name = 'profileModel';
    const def = el('option');
    def.value = '';
    bindText(def, 'options.models.default');
    model.append(def);
    const wantedModel = existing?.model ?? '';
    const setModels = (ids: { id: string; label: string; alias?: true }[]): void => {
      for (const m of ids) {
        if (m.alias) continue; // aliases are not offered, as in Options, Models
        const o = el('option');
        o.value = m.id;
        o.textContent = m.label;
        model.append(o);
      }
      if (wantedModel !== '' && ![...model.options].some((o) => o.value === wantedModel)) { // a model the catalog does not list stays, it is the profile's own
        const o = el('option');
        o.value = wantedModel;
        o.textContent = wantedModel;
        model.append(o);
      }
      model.value = wantedModel;
    };
    setModels([]);
    void api<{ models: { id: string; label: string; alias?: true }[] }>('/api/models').then((res) => {
      if (res.status !== 200) return;
      model.replaceChildren(def);
      setModels(res.body.models);
    });
    const budget = el('input');
    budget.name = 'profileBudget';
    budget.type = 'number';
    budget.min = '1000';
    budget.value = existing?.budgetTokens !== undefined ? String(existing.budgetTokens) : '';
    const readOnly = el('input');
    readOnly.type = 'checkbox';
    readOnly.name = 'profileReadOnly';
    readOnly.checked = existing?.readOnly === true;
    const readOnlyRow = el('label', 'settings-switch');
    const readOnlyText = el('span');
    bindText(readOnlyText, 'options.profiles.readOnly');
    readOnlyRow.append(readOnly, readOnlyText);
    const text = el('textarea');
    text.name = 'profileBody';
    text.rows = 12;
    text.value = existing?.body ?? '';

    const save = button('saveProfile', k('options.profiles.save'));
    const cancel = button('cancelProfile', k('options.profiles.cancel'));
    cancel.addEventListener('click', () => { error.textContent = ''; void showList(); });
    save.addEventListener('click', () => {
      const budgetRaw = budget.value.trim();
      const payload = {
        name: name.value.trim(), description: description.value, model: model.value,
        budgetTokens: budgetRaw === '' ? null : Number(budgetRaw), readOnly: readOnly.checked, body: text.value,
      };
      save.disabled = true;
      void run(api(`/api/profiles/${encodeURIComponent(payload.name)}`, { method: 'PUT', body: payload })).then((ok) => {
        save.disabled = false;
        if (ok) void showList();
      });
    });
    const actions = el('div', 'options-profile-actions options-profile-bar');
    actions.append(cancel, save);
    body.append(
      field(k('options.profiles.name'), name, existing ? undefined : k('options.profiles.name.help')),
      field(k('options.profiles.description'), description),
      field(k('options.profiles.model'), model),
      field(k('options.profiles.budget'), budget, k('options.profiles.budget.help')),
      readOnlyRow, note(k('options.profiles.readOnly.help')),
      field(k('options.profiles.body'), text, k('options.profiles.body.help')),
      actions,
    );
    if (existing?.projectOverrides) body.append(note(k('options.profiles.projectOverrides')));
  };

  void showList();
}
