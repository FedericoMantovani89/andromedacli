// @vitest-environment jsdom
// Options > Secrets: the Groq key is staged for the single Save, never shown back, and the audio warning is on screen before it is typed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPTION_GROUPS, openOptions } from '../src/ui/options';
import type { StateMessage } from '../src/shared/protocol';

const KEY = 'gsk_TESTKEY_not_a_real_key_0123456789';
const options = { config: { models: {}, budget: { loop: {}, quota: {} }, git: {}, agents: {} }, errors: [], paths: { configDir: 'C:/c', profilesDir: 'C:/c/profiles', templatesDir: 'C:/c/templates' }, server: { port: 1 }, profiles: [] };
const state = { settings: { bypassPermissions: false, guardMode: 'enforce', worktrees: true }, project: { name: 'p' }, language: 'en', languages: ['en'], prereq: null } as unknown as StateMessage;

let isSet = false;
let secretsStatus = 200;
let calls: { url: string; method: string; body: unknown }[] = [];
beforeEach(() => {
  isSet = false;
  secretsStatus = 200;
  calls = [];
  document.body.innerHTML = '<div id="overlay" hidden></div>';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    if (url.startsWith('/api/secrets')) {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') calls.push({ url, method, body: JSON.parse(init?.body ?? 'null') });
      return json(secretsStatus, secretsStatus === 200 ? { groq: { set: isSet } } : { code: 'dictation.keyInvalid' });
    }
    if (url === '/api/options') return json(200, structuredClone(options));
    return json(404, null);
  }));
});
afterEach(() => vi.unstubAllGlobals());

const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
const input = (): HTMLInputElement => document.querySelector<HTMLInputElement>('input[name="secrets.groqKey"]')!;
const save = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('button[name="saveOptions"]')!;
const status = (): HTMLElement => document.querySelector<HTMLElement>('[data-secret-status="groq"]')!;
const type = (v: string): void => { input().value = v; input().dispatchEvent(new Event('input')); };

describe('Options > Secrets', () => {
  it('is a global tab', () => {
    expect(OPTION_GROUPS[0].tabs).toContain('secrets');
  });

  it('warns that the audio goes to Groq, and masks the key field', async () => {
    await openOptions(() => state, 'secrets');
    await flush();
    expect(document.querySelector('[data-i18n="options.secrets.groqWarning"]')).not.toBeNull();
    expect(input().type).toBe('password');
    expect(input().autocomplete).toBe('off');
  });

  it('shows n/a when no key is set and "set" when there is one, without ever showing the key', async () => {
    await openOptions(() => state, 'secrets');
    await flush();
    expect(status().dataset.i18n).toBe('common.notAvailable');
    document.body.innerHTML = '<div id="overlay" hidden></div>';
    isSet = true;
    await openOptions(() => state, 'secrets');
    await flush();
    expect(status().dataset.i18n).toBe('options.secrets.set');
    expect(input().value).toBe('');
    expect(document.body.innerHTML).not.toContain(KEY);
  });

  it('stages a typed key: checked first, written on Save, and never echoed back into the page', async () => {
    await openOptions(() => state, 'secrets');
    await flush();
    type(KEY);
    expect(calls).toHaveLength(0); // nothing is sent before Save
    save().click();
    await flush();
    expect(calls.map((c) => [c.method, c.url.includes('dryRun=1')])).toEqual([['PUT', true], ['PUT', false]]);
    expect(calls[1]!.body).toEqual({ groqKey: KEY });
    expect(document.getElementById('overlay')!.hidden).toBe(true);
  });

  it('sends nothing when the field was left empty', async () => {
    await openOptions(() => state, 'secrets');
    await flush();
    save().click();
    await flush();
    expect(calls).toHaveLength(0);
  });

  it('clears the key on Save when asked, and the clear can be undone before Save', async () => {
    isSet = true;
    await openOptions(() => state, 'secrets');
    await flush();
    const clear = document.querySelector<HTMLButtonElement>('button[name="clearGroqKey"]')!;
    clear.click();
    expect(status().dataset.i18n).toBe('options.secrets.willClear');
    clear.click(); // second click: undo
    expect(status().dataset.i18n).toBe('options.secrets.set');
    clear.click();
    save().click();
    await flush();
    expect(calls[calls.length - 1]!.body).toEqual({ groqKey: null });
  });

  it('shows the refusal and keeps the dialog open', async () => {
    await openOptions(() => state, 'secrets');
    await flush();
    type('bad key');
    secretsStatus = 422;
    save().click();
    await flush();
    expect(document.getElementById('overlay')!.hidden).toBe(false);
    expect(document.querySelector('.options-dialog .form-error')!.textContent).not.toBe('');
  });

  it('does not offer to clear when no key is set', async () => {
    await openOptions(() => state, 'secrets');
    await flush();
    expect(document.querySelector('button[name="clearGroqKey"]')).toBeNull();
  });
});
