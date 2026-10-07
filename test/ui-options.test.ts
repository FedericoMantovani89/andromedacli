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

let puts: unknown[] = [];
let putStatus = 200;
beforeEach(() => {
  puts = [];
  putStatus = 200;
  document.body.innerHTML = '<div id="overlay" hidden></div>';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    if (init?.method === 'PUT') { puts.push(JSON.parse(init.body ?? 'null')); return json(putStatus, putStatus === 200 ? {} : { code: 'config.invalid', params: { path: 'x' } }); }
    if (url === '/api/options') return json(200, options);
    if (url === '/api/models') return json(200, { models: [{ id: 'opus', label: 'opus', alias: true }], source: 'shipped', current: '', missing: false });
    if (url === '/api/plugins') return json(200, { source: 'shipped', plugins: [] });
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
  it('a saved field sends only its own entry', async () => {
    await openOptions(() => state);
    document.querySelector<HTMLElement>('.options-tab[data-tab="git"]')!.click();
    const input = document.querySelector<HTMLInputElement>('input[name="git.testTimeoutMinutes"]')!;
    input.value = '30';
    input.dispatchEvent(new Event('change'));
    await flush();
    expect(puts).toEqual([{ git: { testTimeoutMinutes: 30 } }]);
    expect(input.value).toBe('30');
  });
  it('a refused save reverts the field and shows the error', async () => {
    await openOptions(() => state);
    document.querySelector<HTMLElement>('.options-tab[data-tab="budget"]')!.click();
    const input = document.querySelector<HTMLInputElement>('input[name="budget.alertPercent"]')!;
    putStatus = 422;
    input.value = '150';
    input.dispatchEvent(new Event('change'));
    await flush();
    expect(input.value).toBe('80');
    expect(document.querySelector('.form-error')!.textContent).not.toBe('');
  });
  it('a refused bypass switch goes back to off', async () => {
    await openOptions(() => state, 'guard');
    const box = document.querySelector<HTMLInputElement>('input[name="bypass"]')!;
    putStatus = 422;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await flush();
    expect(box.checked).toBe(false);
  });
});
