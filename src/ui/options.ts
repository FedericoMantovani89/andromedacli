import type { ApiError, PrereqResult, StateMessage } from '../shared/protocol';
import { api } from './api';
import { errorText } from './new-agent';
import { bindText, k, language, t } from './i18n-client';
import { closeOverlay, createLanguageSelect, renderPrereqTable } from './settings';
import { openInstallDialog } from './install-dialog';
import { renderNotificationsTab } from './options-notifications';
import { openSaveTemplateDialog } from './new-project';

/** What `GET /api/options` returns (the config is the effective one, defaults filled in). */
interface OptionsPayload {
  config: ConfigView;
  errors: { path: string; code: string }[];
  paths: { configDir: string; profilesDir: string; templatesDir: string };
  server: { port: number };
  profiles: { name: string; source: 'project' | 'user' | 'shipped' | null }[];
  names: { minLength: number; maxLength: number; banned: string[] };
}
type ConfigView = Record<string, unknown>;

interface ModelList {
  models: { id: string; label: string; alias?: true }[];
  source: 'remote' | 'cache' | 'shipped';
  updated?: string;
  current: string;
  missing: boolean;
}
interface PluginRow {
  id: string; category: string; summary: Record<string, string>; trust: string; tier: string; requires: string[]; agentsAllowed: boolean;
  conflicts: Record<string, string>[]; cost: { contextTokens: number | null } | null; notTested: boolean; installCommand: string;
}
interface PluginList { source: string; updated?: string; plugins: PluginRow[] }

/** Every tab of the dialog, in order. Only options that exist today are here (no providers, snapshots, Rizzo Flow...). */
export const OPTION_TABS = ['models', 'profiles', 'budget', 'names', 'projects', 'git', 'guard', 'mod', 'notifications', 'language', 'prerequisites', 'plugins', 'server'] as const;
export type OptionTab = (typeof OPTION_TABS)[number];

interface Env {
  state: StateMessage | undefined;
  options: OptionsPayload | null;
  error: HTMLElement;
  fail(res: { status: number; body: unknown }): boolean;
  getState(): StateMessage | undefined;
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
const heading = (key: string): HTMLElement => {
  const h = el('h3', 'options-heading');
  bindText(h, key);
  return h;
};

const getPath = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((acc, p) => (typeof acc === 'object' && acc !== null ? (acc as Record<string, unknown>)[p] : undefined), obj);
const setPath = (obj: Record<string, unknown>, path: string, value: unknown): void => {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    const next = cur[p];
    cur = typeof next === 'object' && next !== null ? (next as Record<string, unknown>) : (cur[p] = {}) as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
};
const toPatch = (path: string, value: unknown): Record<string, unknown> =>
  path.split('.').reduceRight<unknown>((acc, p) => ({ [p]: acc }), value) as Record<string, unknown>;

/** Saves one config entry; on success the cached config follows, on failure the caller puts the field back. */
async function saveEntry(env: Env, path: string, value: unknown): Promise<boolean> {
  const res = await api<ApiError>('/api/config', { method: 'PUT', body: toPatch(path, value) });
  if (env.fail(res)) return false;
  if (env.options) setPath(env.options.config, path, value);
  return true;
}

type FieldKind = 'number' | 'text' | 'bool' | 'lines';
interface FieldDef { path: string; label: string; kind: FieldKind; help?: string }

/** One editable entry: saves on change through PUT /api/config, shows the server's error and reverts the field when it is refused. */
function createField(env: Env, def: FieldDef): HTMLElement {
  const row = el('label', def.kind === 'bool' ? 'settings-switch' : 'options-field');
  const text = el('span');
  bindText(text, def.label);
  const current = getPath(env.options?.config, def.path);
  if (def.kind === 'bool') {
    const box = el('input');
    box.type = 'checkbox';
    box.name = def.path;
    box.checked = current === true;
    let saved = box.checked;
    box.addEventListener('change', () => {
      const wanted = box.checked;
      void saveEntry(env, def.path, wanted).then((ok) => { if (ok) saved = wanted; else box.checked = saved; });
    });
    row.append(box, text);
  } else if (def.kind === 'lines') {
    const area = el('textarea');
    area.name = def.path;
    area.rows = 5;
    const show = (v: unknown): string => (Array.isArray(v) ? v.join('\n') : '');
    area.value = show(current);
    let saved = area.value;
    area.addEventListener('change', () => {
      const wanted = area.value.split('\n').map((l) => l.trim()).filter((l) => l !== '');
      void saveEntry(env, def.path, wanted).then((ok) => { if (ok) saved = area.value = wanted.join('\n'); else area.value = saved; });
    });
    row.append(text, area);
  } else {
    const input = el('input');
    input.name = def.path;
    input.autocomplete = 'off';
    if (def.kind === 'number') { input.type = 'number'; input.step = '1'; }
    input.value = current === undefined || current === null ? '' : String(current);
    let saved = input.value;
    input.addEventListener('change', () => {
      const raw = input.value.trim();
      const wanted: unknown = def.kind === 'number' ? (raw === '' ? Number.NaN : Number(raw)) : raw;
      if (typeof wanted === 'number' && !Number.isFinite(wanted)) {
        env.fail({ status: 422, body: { code: 'config.invalid', params: { path: def.path } } });
        input.value = saved;
        return;
      }
      void saveEntry(env, def.path, wanted).then((ok) => { if (ok) saved = input.value = String(wanted); else input.value = saved; });
    });
    row.append(text, input);
  }
  if (def.help) {
    const wrap = el('div', 'options-field-wrap');
    wrap.append(row, note(def.help));
    return wrap;
  }
  return row;
}

const fields = (env: Env, defs: FieldDef[]): HTMLElement => {
  const box = el('div', 'settings-agents');
  for (const d of defs) box.append(createField(env, d));
  return box;
};

const unavailable = (env: Env): HTMLElement | undefined => (env.options ? undefined : note(k('options.loadFailed')));

function budgetTab(env: Env): HTMLElement {
  const box = el('div', 'settings-agents');
  const bad = unavailable(env);
  if (bad) { box.append(bad); return box; }
  box.append(
    fields(env, [
      { path: 'agents.maxActiveGlobal', label: k('options.agents.maxActiveGlobal'), kind: 'number' },
      { path: 'agents.maxActivePerProject', label: k('options.agents.maxActivePerProject'), kind: 'number' },
    ]),
    note(k('options.agents.maxActive.help')),
    heading(k('options.budget.tokens')),
    fields(env, [
      { path: 'budget.agentTokens', label: k('options.budget.agentTokens'), kind: 'number' },
      { path: 'budget.alertPercent', label: k('options.budget.alertPercent'), kind: 'number' },
      { path: 'budget.limitPercent', label: k('options.budget.limitPercent'), kind: 'number' },
      { path: 'budget.stopPercent', label: k('options.budget.stopPercent'), kind: 'number' },
      { path: 'budget.graceMinutes', label: k('options.budget.graceMinutes'), kind: 'number' },
    ]),
    heading(k('options.budget.loops')),
    fields(env, [
      { path: 'budget.loop.sameCall', label: k('options.budget.loop.sameCall'), kind: 'number' },
      { path: 'budget.loop.sameError', label: k('options.budget.loop.sameError'), kind: 'number' },
      { path: 'budget.loop.compactions', label: k('options.budget.loop.compactions'), kind: 'number' },
      { path: 'budget.loop.stepMinutes', label: k('options.budget.loop.stepMinutes'), kind: 'number' },
      { path: 'budget.loop.silenceMinutes', label: k('options.budget.loop.silenceMinutes'), kind: 'number' },
    ]),
    heading(k('options.budget.quota')),
    fields(env, [
      { path: 'budget.quota.halvePercent', label: k('options.budget.quota.halvePercent'), kind: 'number' },
      { path: 'budget.quota.freezePercent', label: k('options.budget.quota.freezePercent'), kind: 'number' },
      { path: 'budget.quota.stopPercent', label: k('options.budget.quota.stopPercent'), kind: 'number' },
      { path: 'budget.quota.staggerSeconds', label: k('options.budget.quota.staggerSeconds'), kind: 'number' },
      { path: 'budget.quota.staggerGroup', label: k('options.budget.quota.staggerGroup'), kind: 'number' },
    ]),
    note(k('settings.appliesToNew')),
  );
  return box;
}

/** Whether git is installed (from the prerequisite checks) and, when it is not, the exact command the console would run to install it. */
function gitToolSection(env: Env): HTMLElement {
  const box = el('div', 'options-git-tool');
  box.append(heading(k('options.git.program')));
  const row = el('div', 'prereq-row');
  const status = el('span');
  const detail = el('span');
  const command = el('p', 'settings-note');
  const install = el('button');
  install.type = 'button';
  install.name = 'installGit';
  bindText(install, 'prereq.install');
  const recheck = el('button');
  recheck.type = 'button';
  recheck.name = 'recheckGit';
  bindText(recheck, 'prereq.recheck');
  const show = (results: PrereqResult[] | null): void => {
    const git = results?.find((r) => r.id === 'git');
    if (!git) { status.className = 'prereq-unknown'; bindText(status, 'common.notAvailable'); detail.textContent = ''; } // unknown is never "ok"
    else { status.className = `prereq-${git.status}`; bindText(status, `prereq.status.${git.status}`); detail.textContent = git.version ?? ''; }
    const missing = git !== undefined && (git.status === 'missing' || git.status === 'error');
    install.hidden = !missing;
    command.hidden = !missing;
    if (missing) {
      void api<{ display?: string }>('/api/prereq/git/install').then((res) => {
        if (res.status === 200 && res.body.display) bindText(command, 'options.git.installCommand', { command: res.body.display });
        else bindText(command, 'prereq.install.manual.git');
      });
    }
  };
  show(env.state?.prereq ?? null);
  install.addEventListener('click', () => openInstallDialog('git', () => recheck.click()));
  recheck.addEventListener('click', () => {
    void api<PrereqResult[]>('/api/prereq/recheck', { method: 'POST' }).then((res) => { if (res.status === 200) show(res.body); else env.fail(res); });
  });
  row.append(el('span'), status, detail, install, recheck);
  bindText(row.firstElementChild as HTMLElement, 'prereq.git');
  box.append(row, command);
  return box;
}

/** What the project folder is for git, and the button that makes it a repository when it is not one (nothing starts git on its own). */
function gitProjectSection(env: Env): HTMLElement {
  const box = el('div', 'options-git-project');
  box.append(heading(k('options.git.project')));
  const state = env.state;
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
  init.addEventListener('click', () => {
    init.disabled = true;
    void api<ApiError>('/api/projects/git-init', { method: 'POST' }).then((res) => {
      if (env.fail(res)) { init.disabled = false; return; }
      bindText(message, 'options.git.init.done');
      init.hidden = true;
    });
  });
  box.append(init, note(k('options.git.init.help')));
  return box;
}

function gitTab(env: Env): HTMLElement {
  const box = el('div', 'settings-agents');
  const bad = unavailable(env);
  if (bad) { box.append(bad); return box; }
  box.append(gitToolSection(env), gitProjectSection(env));
  box.append(
    fields(env, [
      { path: 'git.worktrees', label: k('options.git.worktrees'), kind: 'bool', help: k('options.git.worktrees.help') },
      { path: 'git.testTimeoutMinutes', label: k('options.git.testTimeoutMinutes'), kind: 'number' },
      { path: 'git.secretPatterns', label: k('options.git.secretPatterns'), kind: 'lines', help: k('options.git.secretPatterns.help') },
    ]),
    note(k('settings.appliesToNew')),
  );
  return box;
}

function guardTab(env: Env): HTMLElement {
  const state = env.state;
  const box = el('div', 'settings-agents');
  box.append(heading(k('settings.agents')));
  const bypassRow = el('label', 'settings-switch');
  const bypass = el('input');
  bypass.type = 'checkbox';
  bypass.name = 'bypass';
  bypass.checked = state?.settings.bypassPermissions ?? false;
  const bypassText = el('span');
  bindText(bypassText, 'settings.bypass');
  bypassRow.append(bypass, bypassText);
  const warning = el('p', 'settings-warning');
  bindText(warning, 'settings.bypass.warning');
  bypass.addEventListener('change', () => {
    const wanted = bypass.checked;
    void api<ApiError>('/api/config', { method: 'PUT', body: { agents: { bypassPermissions: wanted } } }).then((res) => {
      if (env.fail(res)) bypass.checked = !wanted; // not saved: the switch must not show a state that is not real
    });
  });

  const guardRow = el('label');
  const guardText = el('span');
  bindText(guardText, 'settings.guardMode');
  const guard = el('select');
  guard.name = 'guardMode';
  for (const mode of ['enforce', 'shadow'] as const) {
    const o = el('option');
    o.value = mode;
    bindText(o, mode === 'enforce' ? k('settings.guardMode.enforce') : k('settings.guardMode.shadow'));
    guard.append(o);
  }
  guard.value = state?.settings.guardMode ?? 'enforce';
  let savedMode = guard.value;
  guard.addEventListener('change', () => {
    const wanted = guard.value;
    void api<ApiError>('/api/config', { method: 'PUT', body: { guard: { mode: wanted } } }).then((res) => {
      if (env.fail(res)) guard.value = savedMode;
      else savedMode = wanted;
    });
  });
  guardRow.append(guardText, guard);
  box.append(bypassRow, warning, guardRow, note(k('settings.appliesToNew')));
  return box;
}

function projectsTab(env: Env): HTMLElement {
  const state = env.state;
  const box = el('div', 'settings-agents');
  const squashRow = el('label', 'settings-switch');
  const squash = el('input');
  squash.type = 'checkbox';
  squash.name = 'squash';
  squash.checked = state?.project.squash !== false; // one commit per merged ticket unless the project says otherwise
  const squashText = el('span');
  bindText(squashText, 'settings.squash');
  squashRow.append(squash, squashText);
  squash.addEventListener('change', () => {
    const wanted = squash.checked;
    void api<ApiError>('/api/project', { method: 'PUT', body: { squash: wanted } }).then((res) => {
      if (env.fail(res)) squash.checked = !wanted;
    });
  });

  const testForm = el('form', 'settings-test');
  const testLabel = el('label');
  const testText = el('span');
  bindText(testText, 'settings.testCommand');
  const test = el('input');
  test.name = 'testCommand';
  test.autocomplete = 'off';
  test.value = state?.project.testCommand ?? '';
  testLabel.append(testText, test);
  const save = el('button');
  save.type = 'submit';
  bindText(save, 'common.save');
  testForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void api<ApiError>('/api/project', { method: 'PUT', body: { testCommand: test.value } }).then((res) => { env.fail(res); });
  });
  testForm.append(testLabel, save, note(k('settings.testCommand.help')));
  box.append(squashRow, note(k('settings.squash.help')), testForm);

  // Fields of the project: always shown (a project made from the generic template carries none yet, and this is where they are set).
  const project = (state?.project ?? {}) as Record<string, unknown>;
  for (const [key, label, kind] of [
    ['buildCommand', k('options.projects.buildCommand'), 'text'], ['lintCommand', k('options.projects.lintCommand'), 'text'],
    ['model', k('options.projects.model'), 'text'], ['maxActive', k('options.projects.maxActive'), 'number'],
  ] as const) {
    const row = el('label', 'options-field');
    const span = el('span');
    bindText(span, label);
    const input = el('input');
    input.name = key;
    if (kind === 'number') input.type = 'number';
    input.value = String(project[key] ?? '');
    let saved = input.value;
    input.addEventListener('change', () => {
      const wanted = kind === 'number' ? (input.value.trim() === '' ? null : Number(input.value)) : input.value;
      void api<ApiError>('/api/project', { method: 'PUT', body: { [key]: wanted } }).then((res) => {
        if (env.fail(res)) input.value = saved; else saved = input.value;
      });
    });
    row.append(span, input);
    box.append(row);
  }

  // Another template for this project: its profiles, main.md and rules.md replace the files of the same name; the commands stay.
  const pick = el('select');
  pick.name = 'template';
  const apply = el('button');
  apply.type = 'button';
  apply.name = 'applyTemplate';
  bindText(apply, 'options.projects.template.apply');
  apply.disabled = true;
  const applied = note(k('options.projects.template.help'));
  void api<{ id: string; name: Record<string, string>; valid: boolean }[]>('/api/templates').then((res) => {
    if (res.status !== 200) return;
    for (const item of res.body.filter((x) => x.valid)) {
      const o = el('option');
      o.value = item.id;
      o.textContent = item.name[language()] ?? item.name.en ?? item.id;
      pick.append(o);
    }
    apply.disabled = pick.options.length === 0;
  });
  apply.addEventListener('click', () => {
    apply.disabled = true;
    void api<ApiError>('/api/projects/apply-template', { method: 'POST', body: { templateId: pick.value } }).then((res) => {
      apply.disabled = false;
      if (!env.fail(res)) bindText(applied, 'options.projects.template.done');
    });
  });
  const templateLabel = el('label', 'options-field');
  const templateText = el('span');
  bindText(templateText, 'options.projects.template');
  templateLabel.append(templateText, pick);
  box.append(templateLabel, apply, applied);

  const template = el('button');
  template.type = 'button';
  template.name = 'saveTemplate';
  bindText(template, 'options.projects.saveTemplate');
  template.addEventListener('click', () => openSaveTemplateDialog(env.getState));
  box.append(template);
  return box;
}

function profilesTab(env: Env): HTMLElement {
  const box = el('div', 'settings-agents');
  const bad = unavailable(env);
  if (bad) { box.append(bad); return box; }
  for (const p of env.options!.profiles) {
    const row = el('div', 'options-row');
    const name = el('span');
    name.textContent = p.name;
    const source = el('span', 'settings-note');
    if (p.source) bindText(source, `options.profiles.source.${p.source}`);
    else bindText(source, 'common.notAvailable');
    row.append(name, source);
    box.append(row);
  }
  box.append(note(k('options.profiles.folder'), { path: env.options!.paths.profilesDir }));
  return box;
}

function namesTab(env: Env): HTMLElement {
  const box = el('div', 'settings-agents');
  const bad = unavailable(env);
  if (bad) { box.append(bad); return box; }
  const n = env.options!.names;
  box.append(note(k('options.names.length'), { min: n.minLength, max: n.maxLength }), note(k('options.names.banned'), { words: n.banned.join(', ') }));
  return box;
}

function modTab(env: Env): HTMLElement {
  const box = el('div', 'settings-agents');
  const bad = unavailable(env);
  if (bad) { box.append(bad); return box; }
  const p = el('p');
  bindText(p, getPath(env.options!.config, 'mod.enabled') === true ? k('options.mod.enabled') : k('options.mod.disabled'));
  box.append(p, note(k('options.mod.help')));
  return box;
}

function serverTab(env: Env): HTMLElement {
  const box = el('div', 'settings-agents');
  const bad = unavailable(env);
  if (bad) { box.append(bad); return box; }
  box.append(note(k('options.server.port'), { port: env.options!.server.port }), note(k('options.server.configDir'), { path: env.options!.paths.configDir }));
  return box;
}

function languageTab(env: Env): HTMLElement {
  const row = el('label');
  const text = el('span');
  bindText(text, 'settings.language');
  const select = createLanguageSelect(env.state?.language ?? 'auto', env.state?.languages ?? [], (value) => {
    void api('/api/config', { method: 'PUT', body: { language: value } });
  });
  row.append(text, select);
  return row;
}

function prereqTab(env: Env): HTMLElement {
  const box = el('div');
  const table = el('div');
  renderPrereqTable(table, env.state?.prereq ?? null);
  box.append(heading(k('settings.prerequisites')), table);
  return box;
}

/** The agent model menu: Default, the aliases, then the catalog; a saved choice that left the catalog stays selected with a warning. */
function modelsTab(env: Env): HTMLElement {
  const box = el('div', 'settings-agents');
  const bad = unavailable(env);
  if (bad) { box.append(bad); return box; }
  const row = el('label', 'options-field');
  const text = el('span');
  bindText(text, 'options.models.agent');
  const select = el('select');
  select.name = 'models.agent';
  const refresh = el('button');
  refresh.type = 'button';
  refresh.name = 'refreshModels';
  bindText(refresh, 'options.models.refresh');
  const source = el('p', 'settings-note');
  const missing = el('p', 'settings-warning');
  missing.hidden = true;
  let saved = String(getPath(env.options!.config, 'models.agent') ?? '');

  const render = (list: ModelList): void => {
    select.replaceChildren();
    const def = el('option');
    def.value = '';
    bindText(def, 'options.models.default');
    select.append(def);
    const ids = new Set<string>();
    for (const m of list.models) {
      const o = el('option');
      o.value = m.id;
      o.textContent = m.alias ? `${m.label} (${t('options.models.alias')})` : m.label;
      select.append(o);
      ids.add(m.id);
    }
    if (list.current !== '' && !ids.has(list.current)) { // kept selected: the choice is the user's, even if the catalog dropped it
      const o = el('option');
      o.value = list.current;
      o.textContent = list.current;
      select.append(o);
    }
    select.value = list.current;
    bindText(source, `options.models.source.${list.source}`, { updated: list.updated ?? t('common.notAvailable') });
    missing.hidden = !list.missing;
    if (list.missing) bindText(missing, 'options.models.missing', { model: list.current });
  };
  const load = (path: string, method: string): void => {
    void api<ModelList>(path, { method }).then((res) => { if (res.status === 200) render(res.body); else env.fail(res); });
  };
  select.addEventListener('change', () => {
    const wanted = select.value;
    void saveEntry(env, 'models.agent', wanted).then((ok) => {
      if (ok) { saved = wanted; load('/api/models', 'GET'); } else select.value = saved;
    });
  });
  refresh.addEventListener('click', () => load('/api/models/refresh', 'POST'));
  row.append(text, select);
  box.append(
    row, refresh, source, missing,
    fields(env, [
      { path: 'models.catalogUrl', label: k('options.models.catalogUrl'), kind: 'text', help: k('options.models.catalogUrl.help') },
      { path: 'models.cacheHours', label: k('options.models.cacheHours'), kind: 'number' },
    ]),
    note(k('settings.appliesToNew')),
  );
  load('/api/models', 'GET');
  return box;
}

const TIERS = ['recommended', 'on_request', 'discouraged'] as const;

/** The plugin catalog as a list to read: nothing is installed or enabled from here, the exact command is shown to copy. */
function pluginsTab(env: Env): HTMLElement {
  const box = el('div', 'settings-agents');
  box.append(note(k('options.plugins.readOnly')));
  const body = el('div', 'options-plugins');
  const source = el('p', 'settings-note');
  const refresh = el('button');
  refresh.type = 'button';
  refresh.name = 'refreshPlugins';
  bindText(refresh, 'options.plugins.refresh');
  const lang = language();
  const render = (list: PluginList): void => {
    bindText(source, `options.plugins.source.${list.source}`, { updated: list.updated ?? t('common.notAvailable') });
    body.replaceChildren();
    for (const tier of TIERS) {
      const rows = list.plugins.filter((p) => p.tier === tier);
      if (rows.length === 0) continue;
      const tierTitle = el('h3', 'options-heading');
      bindText(tierTitle, `options.plugins.tier.${tier}`);
      body.append(tierTitle);
      for (const p of rows) {
        const card = el('div', 'options-plugin');
        const title = el('div', 'options-plugin-title');
        const id = el('strong');
        id.textContent = p.id;
        const trust = el('span', 'settings-note');
        bindText(trust, `options.plugins.trust.${p.trust}`);
        title.append(id, trust);
        const summary = el('p');
        summary.textContent = p.summary[lang] ?? p.summary.en ?? '';
        const cost = el('p', 'settings-note');
        bindText(cost, 'options.plugins.cost', { value: p.cost?.contextTokens != null ? p.cost.contextTokens : t('common.notAvailable') });
        card.append(title, summary, cost);
        if (p.requires.length > 0) card.append(note(k('options.plugins.requires'), { list: p.requires.join(', ') }));
        for (const c of p.conflicts) {
          const w = el('p', 'settings-warning');
          w.textContent = c[lang] ?? c.en ?? '';
          card.append(w);
        }
        if (!p.agentsAllowed) card.append(note(k('options.plugins.notForAgents')));
        if (p.notTested) {
          const w = el('p', 'settings-warning');
          bindText(w, 'options.plugins.notTested');
          card.append(w);
        }
        if (tier !== 'discouraged') {
          const cmd = el('input', 'options-command');
          cmd.readOnly = true;
          cmd.value = p.installCommand;
          cmd.name = 'installCommand';
          const copy = el('button');
          copy.type = 'button';
          bindText(copy, 'options.plugins.copy');
          copy.addEventListener('click', () => {
            try { void navigator.clipboard.writeText(p.installCommand).catch(() => cmd.select()); } catch { cmd.select(); }
          });
          const line = el('div', 'options-command-row');
          line.append(cmd, copy);
          card.append(line);
        }
        body.append(card);
      }
    }
  };
  const load = (path: string, method: string): void => {
    void api<PluginList>(path, { method }).then((res) => { if (res.status === 200) render(res.body); else env.fail(res); });
  };
  refresh.addEventListener('click', () => load('/api/plugins/refresh', 'POST'));
  box.append(refresh, source, body);
  load('/api/plugins', 'GET');
  return box;
}

const BUILDERS: Record<OptionTab, (env: Env) => HTMLElement> = {
  models: modelsTab, profiles: profilesTab, budget: budgetTab, names: namesTab, projects: projectsTab, git: gitTab, guard: guardTab, mod: modTab,
  notifications: (env) => {
    const box = el('div');
    if (env.state) renderNotificationsTab(box, env.state);
    return box;
  },
  language: languageTab, prerequisites: prereqTab, plugins: pluginsTab, server: serverTab,
};

/** Opens the tabbed Options dialog (SPEC 5.8). Every editable entry saves when it changes and goes back when the server refuses it. */
export async function openOptions(getState: () => StateMessage | undefined, first: OptionTab = 'models'): Promise<void> {
  const overlay = document.getElementById('overlay')!;
  const loaded = await api<OptionsPayload>('/api/options').catch(() => ({ status: 0, body: null }));
  const dialog = el('div', 'dialog options-dialog');
  dialog.dataset.escape = '';
  const title = el('h2');
  bindText(title, 'settings.title');
  const error = el('div', 'form-error');
  const env: Env = {
    state: getState(), options: loaded.status === 200 ? (loaded.body as OptionsPayload) : null, error, getState,
    fail: (res) => {
      if (res.status === 200) { error.textContent = ''; return false; }
      error.textContent = errorText(res.body as ApiError);
      return true;
    },
  };
  const tabs = el('div', 'options-tabs');
  tabs.setAttribute('role', 'tablist');
  const panel = el('div', 'options-panel');
  panel.setAttribute('role', 'tabpanel');
  const buttons = new Map<OptionTab, HTMLButtonElement>();
  const show = (tab: OptionTab): void => {
    for (const [id, b] of buttons) { b.setAttribute('aria-selected', String(id === tab)); b.classList.toggle('selected', id === tab); }
    error.textContent = '';
    env.state = getState() ?? env.state; // the dialog may stay open while projects and settings change
    panel.replaceChildren(BUILDERS[tab](env));
  };
  for (const id of OPTION_TABS) {
    const b = el('button', 'options-tab');
    b.type = 'button';
    b.dataset.tab = id;
    b.setAttribute('role', 'tab');
    bindText(b, `options.tab.${id}`);
    b.addEventListener('click', () => show(id));
    buttons.set(id, b);
    tabs.append(b);
  }
  const close = el('button');
  bindText(close, 'common.close');
  close.addEventListener('click', closeOverlay);
  dialog.append(title, tabs, panel, error, close);
  overlay.replaceChildren(dialog);
  overlay.hidden = false;
  show(first);
}
