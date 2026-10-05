import type { ApiError, StateMessage } from '../shared/protocol';
import { api } from './api';
import { focusElementFromUser } from './focus';
import { bindText, k, language, t } from './i18n-client';
import { errorText } from './new-agent';
import { closeOverlay } from './settings';

interface TemplateItem {
  id: string;
  name: Record<string, string>;
  description: Record<string, string>;
  source: 'shipped' | 'user';
  valid: boolean;
  reason?: string;
}
interface Detected { build?: string; test?: string; lint?: string; source?: string }

/** Label of the button that opens the save-as-template dialog (the Options dialog of 6E binds it). */
export const SAVE_TEMPLATE_LABEL = k('templates.save.open');

/** A template's text in the interface language, English when it has none. */
const pick = (texts: Record<string, string>): string => texts[language()] ?? texts.en ?? '';

/** A plan name proposed from the folder: its last segment as lowercase words joined by dashes. */
function nameFromFolder(folder: string): string {
  const last = folder.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  return last.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function field(labelKey: string, input: HTMLElement): HTMLLabelElement {
  const label = document.createElement('label');
  const text = document.createElement('span');
  bindText(text, labelKey);
  label.append(text, input);
  return label;
}

function textInput(name: string): HTMLInputElement {
  const input = document.createElement('input');
  input.name = name;
  input.autocomplete = 'off';
  return input;
}

function checkbox(name: string, labelKey: string): { row: HTMLLabelElement; input: HTMLInputElement } {
  const row = document.createElement('label');
  row.className = 'settings-switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.name = name;
  const text = document.createElement('span');
  bindText(text, labelKey);
  row.append(input, text);
  return { row, input };
}

function actions(submitKey: string, onCancel: () => void): { box: HTMLElement; submit: HTMLButtonElement } {
  const box = document.createElement('div');
  box.className = 'form-actions';
  const submit = document.createElement('button');
  submit.type = 'submit';
  bindText(submit, submitKey);
  const cancel = document.createElement('button');
  cancel.type = 'button';
  bindText(cancel, 'common.cancel');
  cancel.addEventListener('click', onCancel);
  box.append(submit, cancel);
  return { box, submit };
}

function showDialog(...children: HTMLElement[]): void {
  const overlay = document.getElementById('overlay')!;
  const dialog = document.createElement('div');
  dialog.className = 'dialog';
  dialog.append(...children);
  overlay.replaceChildren(dialog);
  overlay.hidden = false;
}

/**
 * The new-plan dialog (SPEC 21, 29.2): a template, a folder and a name on one screen; the build, test and lint commands are proposed
 * from what the folder contains. Create makes the plan through `POST /api/plans`; the new tab appears through the state.
 */
export function openNewPlanDialog(_getState: () => StateMessage | undefined, onCreated?: (name: string) => void): void {
  const form = document.createElement('form');
  form.className = 'new-plan-form';
  const title = document.createElement('h2');
  bindText(title, 'plans.new.title');

  const template = document.createElement('select');
  template.name = 'template';
  const description = document.createElement('p');
  description.className = 'settings-note';
  const templates = new Map<string, TemplateItem>();
  const showDescription = (): void => { description.textContent = templates.has(template.value) ? pick(templates.get(template.value)!.description) : ''; };
  template.addEventListener('change', showDescription);

  const folder = textInput('folder');
  const create = checkbox('create', k('plans.new.newFolder'));
  const name = textInput('name');
  let nameEdited = false;
  name.addEventListener('input', () => { nameEdited = true; });
  const build = textInput('build');
  const test = textInput('test');
  const lint = textInput('lint');
  const note = document.createElement('p');
  note.className = 'settings-note';
  const error = document.createElement('div');
  error.className = 'form-error';

  const detect = async (): Promise<void> => {
    const root = folder.value.trim();
    if (!nameEdited) name.value = nameFromFolder(root);
    note.textContent = '';
    if (root === '') return;
    const res = await api<Detected | ApiError>(`/api/plans/detect?root=${encodeURIComponent(root)}`);
    if (res.status !== 200) return; // a folder that does not exist yet (a new one) has nothing to read
    const found = res.body as Detected;
    if (!found.source) { bindText(note, 'plans.new.detect.none'); return; }
    build.value = found.build ?? '';
    test.value = found.test ?? '';
    lint.value = found.lint ?? '';
    bindText(note, 'plans.new.detect.found', { source: found.source });
  };
  folder.addEventListener('blur', () => { void detect(); });
  // The native folder window (the console runs on the user's own machine, so it can open one: a page cannot learn a full path).
  const browse = document.createElement('button');
  browse.type = 'button';
  browse.className = 'browse-folder';
  bindText(browse, 'plans.new.browse');
  const browseNote = document.createElement('p');
  browseNote.className = 'settings-note browse-note';
  browse.addEventListener('click', () => {
    browseNote.textContent = '';
    error.textContent = '';
    browse.disabled = true;
    void api<{ status: string; path?: string } | ApiError>('/api/pick-folder', { method: 'POST', body: {} }).then(async (res) => {
      if (res.status !== 200) { error.textContent = errorText(res.body as ApiError); return; }
      const out = res.body as { status: string; path?: string };
      if (out.status === 'picked' && out.path) { folder.value = out.path; await detect(); }
      else if (out.status === 'unavailable') bindText(browseNote, 'folder.unavailable');
    }).finally(() => { browse.disabled = false; });
  });
  create.input.addEventListener('change', () => { void detect(); });

  void api<TemplateItem[]>('/api/templates').then((res) => {
    if (res.status !== 200) return;
    for (const item of res.body) {
      templates.set(item.id, item);
      const o = document.createElement('option');
      o.value = item.id;
      o.disabled = !item.valid;
      o.textContent = item.valid ? pick(item.name) : t('templates.invalid', { name: pick(item.name) || item.id });
      template.append(o);
    }
    const first = res.body.find((x) => x.id === 'backend-java' && x.valid) ?? res.body.find((x) => x.valid);
    if (first) template.value = first.id;
    else { const none = document.createElement('option'); bindText(none, 'templates.empty'); none.disabled = true; template.append(none); }
    showDescription();
  });

  const { box, submit } = actions(k('common.create'), closeOverlay);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    const typed = (v: string): string | undefined => (v.trim() === '' ? undefined : v.trim());
    void api<ApiError>('/api/plans', {
      method: 'POST',
      body: {
        root: folder.value.trim(), ...(name.value.trim() ? { name: name.value.trim() } : {}), templateId: template.value,
        create: create.input.checked, build: typed(build.value), test: typed(test.value), lint: typed(lint.value),
      },
    }).then((res) => {
      if (res.status >= 200 && res.status < 300) { closeOverlay(); onCreated?.(String((res.body as { name?: unknown }).name ?? '')); }
      else error.textContent = errorText(res.body as ApiError);
    }).finally(() => { submit.disabled = false; });
  });

  const folderRow = document.createElement('div');
  folderRow.className = 'folder-row';
  folderRow.append(field(k('plans.new.folder'), folder), browse);
  form.append(title, field(k('plans.new.template'), template), description, folderRow, browseNote, create.row, field(k('plans.new.name'), name),
    field(k('plans.new.build'), build), field(k('plans.new.test'), test), field(k('plans.new.lint'), lint), note, error, box);
  showDialog(form);
  focusElementFromUser(folder, 'user'); // the user just clicked "new plan": the cursor may go into the first field
}

/** "Save plan as template": a copy of the current plan's profiles, rules and settings, kept in the user's templates (SPEC 21). */
export function openSaveTemplateDialog(_getState: () => StateMessage | undefined): void {
  const form = document.createElement('form');
  const title = document.createElement('h2');
  bindText(title, 'templates.save.title');
  const id = textInput('id');
  const name = textInput('name');
  const overwrite = checkbox('overwrite', k('templates.save.overwrite'));
  const error = document.createElement('div');
  error.className = 'form-error';
  const done = document.createElement('p');
  done.className = 'settings-note';
  const { box, submit } = actions(k('common.save'), closeOverlay);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    error.textContent = '';
    done.textContent = '';
    submit.disabled = true;
    void api<ApiError>('/api/plans/save-template', {
      method: 'POST',
      body: { id: id.value.trim(), ...(name.value.trim() ? { name: name.value.trim() } : {}), overwrite: overwrite.input.checked },
    }).then((res) => {
      if (res.status >= 200 && res.status < 300) bindText(done, 'templates.save.done', { id: id.value.trim() });
      else error.textContent = errorText(res.body as ApiError);
    }).finally(() => { submit.disabled = false; });
  });
  form.append(title, field(k('templates.save.id'), id), field(k('templates.save.name'), name), overwrite.row, done, error, box);
  showDialog(form);
  focusElementFromUser(id, 'user');
}
