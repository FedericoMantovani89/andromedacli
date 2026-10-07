// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPTION_TABS, openOptions } from '../src/ui/options';
import type { StateMessage } from '../src/shared/protocol';

const options = {
  config: { agents: { maxActiveGlobal: 4, maxActivePerProject: 3, bypassPermissions: false }, git: { worktrees: true, testTimeoutMinutes: 15, secretPatterns: ['.env'] }, mod: { enabled: true },
    budget: { agentTokens: 400000, alertPercent: 80, limitPercent: 100, stopPercent: 110, graceMinutes: 5, loop: {}, quota: {} }, models: { agent: '', catalogUrl: '', cacheHours: 6 } },
  errors: [], paths: { configDir: 'C:/c', profilesDir: 'C:/c/profiles', templatesDir: 'C:/c/templates' }, server: { port: 7391 },
  profiles: [{ name: 'backend', source: 'shipped' }], names: { minLength: 3, maxLength: 40, banned: ['agent'] },
};
const state = { settings: { bypassPermissions: false, guardMode: 'enforce', worktrees: true }, project: { name: 'p' }, language: 'en', languages: ['en', 'it'], prereq: null } as unknown as StateMessage;

let posts: string[] = [];
let puts: unknown[] = [];
let putStatus = 200;
beforeEach(() => {
  puts = [];
  posts = [];
  putStatus = 200;
  document.body.innerHTML = '<div id="overlay" hidden></div>';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    if (init?.method === 'PUT') { puts.push(JSON.parse(init.body ?? 'null')); return json(putStatus, putStatus === 200 ? {} : { code: 'config.invalid', params: { path: 'x' } }); }
    if (init?.method === 'POST') { posts.push(url); return json(200, url === '/api/prereq/recheck' ? [{ id: 'git', status: 'ok', version: '2.50', required: true }] : { ok: true }); }
    if (url === '/api/prereq/git/install') return json(200, { id: 'git', action: 'install', display: 'winget install --id Git.Git -e --source winget' });
    if (url === '/api/options') return json(200, structuredClone(options)); // a fresh copy: staged edits change the object they are given
    if (url === '/api/models') return json(200, { models: [{ id: 'opus', label: 'opus', alias: true }], source: 'shipped', current: '', missing: false });
    if (url === '/api/plugins') return json(200, { source: 'shipped', plugins: [] });
    if (url === '/api/profiles') return json(200, [{ name: 'backend', description: 'Backend', body: 'x', readOnly: false, source: 'shipped', shipped: true, userFile: false, projectOverrides: false }]);
    return json(404, null);
  }));
});
afterEach(() => vi.unstubAllGlobals());

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('options dialog', () => {
  it('renders every tab and shows only the selected panel', async () => {
    await openOptions(() => state);
    const tabs = [...document.querySelectorAll<HTMLElement>('.options-tab')].map((b) => b.dataset.tab);
    expect(tabs).toEqual([...OPTION_TABS]);
    document.querySelector<HTMLElement>('.options-tab[data-tab="git"]')!.click();
    expect(document.querySelector('input[name="git.testTimeoutMinutes"]')).not.toBeNull();
    expect(document.querySelector('input[name="bypass"]')).toBeNull();
    document.querySelector<HTMLElement>('.options-tab[data-tab="guard"]')!.click();
    expect(document.querySelector('input[name="bypass"]')).not.toBeNull();
    expect(document.querySelector('select[name="guardMode"]')).not.toBeNull();
  });
  it('the Git tab shows the git check, the install command when it is missing, and the git init button for a folder that is no repository', async () => {
    const missing = { ...state, projectIsRepo: false, repos: [], prereq: [{ id: 'git', status: 'missing', required: true }] } as unknown as StateMessage;
    await openOptions(() => missing);
    document.querySelector<HTMLElement>('.options-tab[data-tab="git"]')!.click();
    await flush();
    expect(document.querySelector<HTMLElement>('.options-git-tool .prereq-missing')).not.toBeNull();
    expect(document.querySelector<HTMLElement>('.options-git-tool button[name="installGit"]')!.hidden).toBe(false);
    expect(document.querySelector('.options-git-tool .settings-note')!.getAttribute('data-i18n-params')).toContain('winget install');
    document.querySelector<HTMLButtonElement>('button[name="gitInit"]')!.click();
    await flush();
    expect(posts).toContain('/api/projects/git-init');
    expect(document.querySelector<HTMLElement>('button[name="gitInit"]')!.hidden).toBe(true);
  });
  it('the Git tab has no git init button when the folder is already a repository, and no install button when git is there', async () => {
    const fine = { ...state, projectIsRepo: true, repos: [''], prereq: [{ id: 'git', status: 'ok', version: '2.50', required: true }] } as unknown as StateMessage;
    await openOptions(() => fine);
    document.querySelector<HTMLElement>('.options-tab[data-tab="git"]')!.click();
    await flush();
    expect(document.querySelector('button[name="gitInit"]')).toBeNull();
    expect(document.querySelector<HTMLElement>('.options-git-tool button[name="installGit"]')!.hidden).toBe(true);
  });
  it('the Project tab lets the template be applied to the open project', async () => {
    await openOptions(() => state);
    document.querySelector<HTMLElement>('.options-tab[data-tab="projects"]')!.click();
    expect(document.querySelector('select[name="template"]')).not.toBeNull();
    expect(document.querySelector('button[name="applyTemplate"]')).not.toBeNull();
  });
  const clickSave = async (): Promise<void> => { document.querySelector<HTMLElement>('button[name="saveOptions"]')!.click(); await flush(); await flush(); };
  it('a changed field is staged, and Save sends only its own entry and closes the dialog', async () => {
    await openOptions(() => state);
    document.querySelector<HTMLElement>('.options-tab[data-tab="git"]')!.click();
    const input = document.querySelector<HTMLInputElement>('input[name="git.testTimeoutMinutes"]')!;
    input.value = '30';
    input.dispatchEvent(new Event('change'));
    await flush();
    expect(puts).toEqual([]);
    await clickSave();
    expect(puts).toEqual([{ git: { testTimeoutMinutes: 30 } }]);
    expect(document.getElementById('overlay')!.hidden).toBe(true);
  });
  it('an edit survives a visit to another tab', async () => {
    await openOptions(() => state);
    document.querySelector<HTMLElement>('.options-tab[data-tab="git"]')!.click();
    const input = document.querySelector<HTMLInputElement>('input[name="git.testTimeoutMinutes"]')!;
    input.value = '30';
    input.dispatchEvent(new Event('change'));
    document.querySelector<HTMLElement>('.options-tab[data-tab="budget"]')!.click();
    document.querySelector<HTMLElement>('.options-tab[data-tab="git"]')!.click();
    expect(document.querySelector<HTMLInputElement>('input[name="git.testTimeoutMinutes"]')!.value).toBe('30');
  });
  it('a refused save shows the error, keeps the dialog open and keeps what was typed', async () => {
    await openOptions(() => state);
    document.querySelector<HTMLElement>('.options-tab[data-tab="budget"]')!.click();
    const input = document.querySelector<HTMLInputElement>('input[name="budget.alertPercent"]')!;
    putStatus = 422;
    input.value = '150';
    input.dispatchEvent(new Event('change'));
    await clickSave();
    expect(input.value).toBe('150');
    expect(document.querySelector('.form-error')!.textContent).not.toBe('');
    expect(document.getElementById('overlay')!.hidden).toBe(false);
  });
  it('the X closes the dialog without sending anything', async () => {
    await openOptions(() => state, 'guard');
    const box = document.querySelector<HTMLInputElement>('input[name="bypass"]')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    document.querySelector<HTMLElement>('button[name="closeOptions"]')!.click();
    await flush();
    expect(puts).toEqual([]);
    expect(document.getElementById('overlay')!.hidden).toBe(true);
  });
  it('changing the bypass switch asks to restart after Save; a plain setting does not', async () => {
    await openOptions(() => state, 'guard');
    const box = document.querySelector<HTMLInputElement>('input[name="bypass"]')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await clickSave();
    expect(puts).toEqual([{ agents: { bypassPermissions: true } }]);
    expect(document.querySelector('.restart-dialog')).not.toBeNull();
    document.querySelector<HTMLElement>('button[name="restartNo"]')!.click();
    expect(document.getElementById('overlay')!.hidden).toBe(true);
    await openOptions(() => state, 'git');
    const input = document.querySelector<HTMLInputElement>('input[name="git.testTimeoutMinutes"]')!;
    input.value = '20';
    input.dispatchEvent(new Event('change'));
    await clickSave();
    expect(document.querySelector('.restart-dialog')).toBeNull();
  });
  it('the dialog Save is hidden while a profile is being edited, and back with Annulla', async () => {
    await openOptions(() => state, 'profiles');
    await flush();
    const saveBtn = document.querySelector<HTMLButtonElement>('button[name="saveOptions"]')!;
    expect(saveBtn.hidden).toBe(false);
    document.querySelector<HTMLElement>('button[name="newProfile"]')!.click();
    expect(saveBtn.hidden).toBe(true);
    document.querySelector<HTMLElement>('.options-tab[data-tab="git"]')!.click();
    expect(saveBtn.hidden).toBe(false); // another tab: the dialog's Save is back
    document.querySelector<HTMLElement>('.options-tab[data-tab="profiles"]')!.click();
    expect(saveBtn.hidden).toBe(true); // the form is still open there
    document.querySelector<HTMLElement>('button[name="cancelProfile"]')!.click();
    await flush();
    expect(saveBtn.hidden).toBe(false);
  });
  it('the models menu offers Default and real models only, never an alias', async () => {
    await openOptions(() => state, 'models');
    await flush();
    await flush();
    expect([...document.querySelectorAll<HTMLOptionElement>('select[name="models.agent"] option')].map((o) => o.value)).toEqual(['']);
  });
});
