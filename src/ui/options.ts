import type { ApiError, PrereqResult, StateMessage } from '../shared/protocol';
import { api } from './api';
import { errorText } from './new-agent';
import { bindText, k, language, setLanguage, setTitle, t } from './i18n-client';
import { closeOverlay, createLanguageSelect, renderPrereqTable } from './settings';
import { openInstallDialog } from './install-dialog';
import { openRestartDialog } from './restart-dialog';
import { renderProfilesTab } from './options-profiles';
import { renderGitProject } from './git-section';
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
  /** Remembers a change until Save: one request per key, the last one wins. Nothing is sent before Save. */
  stage(key: string, run: () => Promise<{ status: number; body: unknown }>): void;
  /** The Profiles tab is showing its own form (with its own buttons): the dialog's Save is hidden meanwhile. */
  profileEditing(on: boolean): void;
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
const footnote = (key: string): HTMLElement => {
  const p = note(key);
  p.classList.add('options-footnote');
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

/** Stages one config entry (sent by Save); the cached config follows at once so a tab built again shows the pending value. */
function saveEntry(env: Env, path: string, value: unknown): void {
  if (env.options) setPath(env.options.config, path, value);
  env.stage(`config:${path}`, () => api<ApiError>('/api/config', { method: 'PUT', body: toPatch(path, value) }));
}

type FieldKind = 'number' | 'text' | 'bool' | 'lines';
interface FieldDef { path: string; label: string; kind: FieldKind; help?: string }

/** One editable entry: a change is staged for Save (PUT /api/config); a value that is not a number is refused at once. */
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
    box.addEventListener('change', () => saveEntry(env, def.path, box.checked));
    row.append(box, text);
  } else if (def.kind === 'lines') {
    const area = el('textarea');
    area.name = def.path;
    area.rows = 5;
    const show = (v: unknown): string => (Array.isArray(v) ? v.join('\n') : '');
    area.value = show(current);
    area.addEventListener('change', () => {
      const wanted = area.value.split('\n').map((l) => l.trim()).filter((l) => l !== '');
      area.value = wanted.join('\n');
      saveEntry(env, def.path, wanted);
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
      saved = input.value = String(wanted);
      saveEntry(env, def.path, wanted);
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

interface SliderDef { path: string; label: string; min: number; max: number; step: number; format?: (n: number) => string }

/** A horizontal slider with its value shown at the right in a read-only box. `onValue` runs with the value after every move. */
function createSlider(def: SliderDef, start: number, onValue: (n: number, slider: HTMLInputElement) => number): { row: HTMLElement; set(n: number): void; get(): number } {
  const row = el('div', 'options-slider');
  const text = el('span', 'options-slider-label');
  bindText(text, def.label);
  const input = el('input');
  input.type = 'range';
  input.name = def.path;
  input.min = String(def.min);
  input.step = String(def.step);
  // A saved value beyond the usual range stays reachable: the scale grows to hold it.
  input.max = String(Math.max(def.max, start));
  const out = el('output', 'options-slider-value');
  const fmt = def.format ?? ((n: number) => String(n));
  const paint = (): void => {
    const n = Number(input.value);
    out.textContent = fmt(n);
    input.style.setProperty('--fill', `${((n - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100}%`);
  };
  const set = (n: number): void => { input.value = String(n); paint(); };
  input.value = String(start);
  paint();
  input.addEventListener('input', () => { set(onValue(Number(input.value), input)); });
  const line = el('div', 'options-slider-line');
  line.append(input, out);
  row.append(text, line);
  return { row, set, get: () => Number(input.value) };
}

const groupNumber = (n: number): string => new Intl.NumberFormat(language()).format(n);

/** One slider for one config entry (staged like any field). */
function sliderField(env: Env, def: SliderDef): HTMLElement {
  const start = Number(getPath(env.options?.config, def.path) ?? def.min);
  const s = createSlider(def, start, (n) => { saveEntry(env, def.path, n); return n; });
  return s.row;
}

/**
 * Sliders that must stay in order (alert below restriction below stop): moving one stops at its neighbour, and the whole group is sent as one
 * request, because the server checks the order of the group and a value sent alone could be refused against the old values of the others.
 * `gaps[i]` is the least distance from slider i to slider i+1.
 */
function sliderGroup(env: Env, defs: SliderDef[], gaps: number[]): HTMLElement {
  const box = el('div', 'options-slider-group');
  const values = defs.map((d) => Number(getPath(env.options?.config, d.path) ?? d.min));
  const sliders: ReturnType<typeof createSlider>[] = [];
  const stage = (): void => {
    const patch: Record<string, unknown> = {};
    defs.forEach((d, i) => { setPath(patch, d.path, values[i]); if (env.options) setPath(env.options.config, d.path, values[i]); });
    env.stage(`config:${defs[0]!.path}+`, () => api<ApiError>('/api/config', { method: 'PUT', body: patch }));
  };
  defs.forEach((d, i) => {
    sliders.push(createSlider(d, values[i]!, (n) => {
      const lo = i > 0 ? values[i - 1]! + gaps[i - 1]! : d.min;
      const hi = i < defs.length - 1 ? values[i + 1]! - gaps[i]! : Number.POSITIVE_INFINITY;
      values[i] = Math.min(Math.max(n, lo), hi);
      stage();
      return values[i]!;
    }));
    box.append(sliders[i]!.row);
  });
  return box;
}

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
    sliderField(env, { path: 'budget.agentTokens', label: k('options.budget.agentTokens'), min: 50_000, max: 2_000_000, step: 50_000, format: groupNumber }),
    sliderGroup(env, [
      { path: 'budget.alertPercent', label: k('options.budget.alertPercent'), min: 5, max: 200, step: 5, format: (n) => `${n} %` },
      { path: 'budget.limitPercent', label: k('options.budget.limitPercent'), min: 5, max: 200, step: 5, format: (n) => `${n} %` },
      { path: 'budget.stopPercent', label: k('options.budget.stopPercent'), min: 5, max: 200, step: 5, format: (n) => `${n} %` },
    ], [5, 0]),
    fields(env, [{ path: 'budget.graceMinutes', label: k('options.budget.graceMinutes'), kind: 'number' }]),
    heading(k('options.budget.loops')),
    fields(env, [
      { path: 'budget.loop.sameCall', label: k('options.budget.loop.sameCall'), kind: 'number' },
      { path: 'budget.loop.sameError', label: k('options.budget.loop.sameError'), kind: 'number' },
      { path: 'budget.loop.compactions', label: k('options.budget.loop.compactions'), kind: 'number' },
      { path: 'budget.loop.stepMinutes', label: k('options.budget.loop.stepMinutes'), kind: 'number' },
      { path: 'budget.loop.silenceMinutes', label: k('options.budget.loop.silenceMinutes'), kind: 'number' },
    ]),
    heading(k('options.budget.quota')),
    sliderGroup(env, [
      { path: 'budget.quota.halvePercent', label: k('options.budget.quota.halvePercent'), min: 5, max: 100, step: 5, format: (n) => `${n} %` },
      { path: 'budget.quota.freezePercent', label: k('options.budget.quota.freezePercent'), min: 5, max: 100, step: 5, format: (n) => `${n} %` },
      { path: 'budget.quota.stopPercent', label: k('options.budget.quota.stopPercent'), min: 5, max: 100, step: 5, format: (n) => `${n} %` },
    ], [5, 5]),
    fields(env, [
      { path: 'budget.quota.staggerSeconds', label: k('options.budget.quota.staggerSeconds'), kind: 'number' },
      { path: 'budget.quota.staggerGroup', label: k('options.budget.quota.staggerGroup'), kind: 'number' },
    ]),
    footnote(k('options.budget.appliesToNew')),
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

function gitTab(env: Env): HTMLElement {
  const box = el('div', 'settings-agents');
  const bad = unavailable(env);
  if (bad) { box.append(bad); return box; }
  box.append(gitToolSection(env), renderGitProject(env.state, env.fail, heading(k('options.git.project'))));
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
    saveEntry(env, 'agents.bypassPermissions', bypass.checked);
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
  guard.addEventListener('change', () => saveEntry(env, 'guard.mode', guard.value));
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
    env.stage('project:squash', () => api<ApiError>('/api/project', { method: 'PUT', body: { squash: wanted } }));
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
  testForm.addEventListener('submit', (ev) => ev.preventDefault());
  test.addEventListener('change', () => {
    const wanted = test.value;
    env.stage('project:testCommand', () => api<ApiError>('/api/project', { method: 'PUT', body: { testCommand: wanted } }));
  });
  testForm.append(testLabel, note(k('settings.testCommand.help')));
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
    input.addEventListener('change', () => {
      const wanted = kind === 'number' ? (input.value.trim() === '' ? null : Number(input.value)) : input.value;
      env.stage(`project:${key}`, () => api<ApiError>('/api/project', { method: 'PUT', body: { [key]: wanted } }));
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
  renderProfilesTab(box, env.options!.paths.profilesDir, (on) => env.profileEditing(on));
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
  const select = createLanguageSelect(env.state?.language ?? 'en', env.state?.languages ?? [], (value) => {
    env.stage('config:language', () => api<ApiError>('/api/config', { method: 'PUT', body: { language: value } }));
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

/** The agent model menu: Default, then the catalog's real models; a saved choice that left the catalog stays selected with a warning. */
function modelsTab(env: Env): HTMLElement {
  const box = el('div', 'settings-agents options-models');
  const bad = unavailable(env);
  if (bad) { box.append(bad); return box; }
  const head = el('div', 'options-field-head');
  const text = el('span');
  bindText(text, 'options.models.agent');
  const updated = el('span', 'settings-note');
  head.append(text, updated);
  const select = el('select');
  select.name = 'models.agent';
  const refresh = el('button', 'icon-btn icon-refresh');
  refresh.type = 'button';
  refresh.name = 'refreshModels';
  setTitle(refresh, k('options.models.refresh'));
  const pick = el('div', 'options-select-row');
  pick.append(select, refresh);
  const missing = el('p', 'settings-warning');
  missing.hidden = true;
  let wantedModel = String(getPath(env.options!.config, 'models.agent') ?? '');

  const render = (list: ModelList): void => {
    select.replaceChildren();
    const def = el('option');
    def.value = '';
    bindText(def, 'options.models.default');
    select.append(def);
    const ids = new Set<string>();
    for (const m of list.models) {
      if (m.alias) continue; // aliases are not offered: only real model ids
      const o = el('option');
      o.value = m.id;
      o.textContent = m.label;
      select.append(o);
      ids.add(m.id);
    }
    const current = wantedModel;
    if (current !== '' && !ids.has(current)) { // kept selected: the choice is the user's, even if the catalog dropped it
      const o = el('option');
      o.value = current;
      o.textContent = current;
      select.append(o);
    }
    select.value = current;
    bindText(updated, 'options.models.updated', { updated: list.updated ?? t('common.notAvailable') });
    missing.hidden = !(list.missing && current === list.current);
    if (!missing.hidden) bindText(missing, 'options.models.missing', { model: current });
  };
  const load = (path: string, method: string): void => {
    void api<ModelList>(path, { method }).then((res) => { if (res.status === 200) render(res.body); else env.fail(res); });
  };
  select.addEventListener('change', () => {
    wantedModel = select.value;
    saveEntry(env, 'models.agent', wantedModel);
    missing.hidden = true;
  });
  refresh.addEventListener('click', () => load('/api/models/refresh', 'POST'));

  const urlLabel = el('label', 'options-field');
  const urlHead = el('span', 'options-field-head');
  const urlText = el('span');
  bindText(urlText, 'options.models.catalogUrl');
  const info = el('span', 'info-icon');
  setTitle(info, k('options.models.catalogUrl.help'));
  info.tabIndex = 0;
  urlHead.append(urlText, info);
  const url = el('input');
  url.name = 'models.catalogUrl';
  url.autocomplete = 'off';
  url.value = String(getPath(env.options!.config, 'models.catalogUrl') ?? '');
  url.addEventListener('change', () => saveEntry(env, 'models.catalogUrl', url.value.trim()));
  urlLabel.append(urlHead, url);

  const foot = note(k('settings.appliesToNew'));
  foot.classList.add('options-footnote');
  const agentRow = el('div', 'options-field');
  agentRow.append(head, pick);
  box.append(agentRow, missing, urlLabel, foot);
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

/** Settings Claude reads only when a session starts: a changed one asks for a restart after Save. */
const RESTART_PATHS = ['agents.bypassPermissions', 'guard.mode', 'models.agent'] as const;

const BUILDERS: Record<OptionTab, (env: Env) => HTMLElement> = {
  models: modelsTab, profiles: profilesTab, budget: budgetTab, names: namesTab, projects: projectsTab, git: gitTab, guard: guardTab, mod: modTab,
  notifications: (env) => {
    const box = el('div');
    if (env.state) renderNotificationsTab(box, env.state, env.stage);
    return box;
  },
  language: languageTab, prerequisites: prereqTab, plugins: pluginsTab, server: serverTab,
};

/** Where a restart-relevant setting is when the options payload has no value for it (the guard tab reads the state, not the config). */
function getRestartDefault(path: (typeof RESTART_PATHS)[number], state: StateMessage | undefined): unknown {
  if (path === 'agents.bypassPermissions') return state?.settings.bypassPermissions ?? false;
  if (path === 'guard.mode') return state?.settings.guardMode ?? 'enforce';
  return '';
}

/** Opens the tabbed Options dialog (SPEC 5.8). Changes are staged while editing; Save sends them and closes, X discards them. */
export async function openOptions(getState: () => StateMessage | undefined, first: OptionTab = 'models'): Promise<void> {
  const overlay = document.getElementById('overlay')!;
  const loaded = await api<OptionsPayload>('/api/options').catch(() => ({ status: 0, body: null }));
  const dialog = el('div', 'dialog options-dialog');
  dialog.dataset.escape = '';
  const title = el('h2');
  bindText(title, 'settings.title');
  const error = el('div', 'form-error');
  const pending = new Map<string, () => Promise<{ status: number; body: unknown }>>();
  let editingProfile = false;
  let current: OptionTab = first;
  let syncSave = (): void => undefined; // set once the Save button exists
  const startLanguage = getState()?.language;
  const env: Env = {
    state: getState(), options: loaded.status === 200 ? (loaded.body as OptionsPayload) : null, error, getState,
    fail: (res) => {
      if (res.status === 200) { error.textContent = ''; return false; }
      error.textContent = errorText(res.body as ApiError);
      return true;
    },
    stage: (key, run) => { pending.delete(key); pending.set(key, run); },
    profileEditing: (on) => { editingProfile = on; syncSave(); },
  };
  const tabs = el('div', 'options-tabs');
  tabs.setAttribute('role', 'tablist');
  const panel = el('div', 'options-panel');
  panel.setAttribute('role', 'tabpanel');
  const buttons = new Map<OptionTab, HTMLButtonElement>();
  const built = new Map<OptionTab, HTMLElement>(); // a tab keeps its fields while another is shown, so staged edits are not lost
  const LIVE: readonly OptionTab[] = ['prerequisites', 'plugins']; // read-only views rebuilt on every visit
  const show = (tab: OptionTab): void => {
    for (const [id, b] of buttons) { b.setAttribute('aria-selected', String(id === tab)); b.classList.toggle('selected', id === tab); }
    error.textContent = '';
    current = tab;
    syncSave();
    env.state = getState() ?? env.state; // the dialog may stay open while projects and settings change
    let view = built.get(tab);
    if (!view || LIVE.includes(tab)) { view = BUILDERS[tab](env); built.set(tab, view); }
    panel.replaceChildren(view);
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
  const x = el('button', 'icon-btn dialog-x');
  x.type = 'button';
  x.name = 'closeOptions';
  setTitle(x, 'common.close');
  x.addEventListener('click', () => {
    const lang = startLanguage;
    closeOverlay();
    if (lang !== undefined && lang !== language()) void setLanguage(lang); // a language previewed but not saved goes back
  });
  const save = el('button');
  save.type = 'button';
  save.name = 'saveOptions';
  const readNow = (): unknown[] => RESTART_PATHS.map((p) => getPath(env.options?.config, p) ?? getRestartDefault(p, getState()));
  const before = readNow();
  bindText(save, 'common.save');
  save.addEventListener('click', () => {
    save.disabled = true;
    void (async () => {
      for (const [key, run] of [...pending]) {
        const res = await run().catch(() => ({ status: 0, body: { code: 'network' } }));
        if (env.fail(res)) { save.disabled = false; return; } // stays open with what was refused still staged
        pending.delete(key);
      }
      // The guard and bypass tabs are built from the state, the others from the config: the staged value is in the config either way.
      const after = readNow();
      const settings = after.some((v, i) => JSON.stringify(v) !== JSON.stringify(before[i]));
      const programs = getState()?.prereq?.some((r) => r.status === 'restart') === true;
      if (settings || programs) openRestartDialog({ settings, programs });
      else closeOverlay();
    })();
  });
  syncSave = (): void => { save.hidden = editingProfile && current === 'profiles'; };
  dialog.append(title, x, tabs, panel, error, save);
  overlay.replaceChildren(dialog);
  overlay.hidden = false;
  show(first);
}
