// @vitest-environment jsdom
// Options > Secrets: the Groq key is staged for the single Save, never shown back, and the audio warning is on screen before it is typed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPTION_GROUPS, openOptions } from '../src/ui/options';
import type { StateMessage } from '../src/shared/protocol';

const KEY = 'gsk_TESTKEY_not_a_real_key_0123456789';
const options = { config: { models: {}, budget: { loop: {}, quota: {} }, git: {}, agents: {} }, errors: [], paths: { configDir: 'C:/c', profilesDir: 'C:/c/profiles', templatesDir: 'C:/c/templates' }, server: { port: 1 }, profiles: [] };
const state = { settings: { bypassPermissions: false, guardMode: 'enforce', worktrees: true }, project: { name: 'p' }, language: 'en', languages: ['en'], prereq: null } as unknown as StateMessage;

let isSet = false;
let withPreview = true;
let secretsStatus = 200;
let calls: { url: string; method: string; body: unknown }[] = [];
beforeEach(() => {
  isSet = false;
  withPreview = true;
  secretsStatus = 200;
  calls = [];
  document.body.innerHTML = '<div id="overlay" hidden></div>';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    if (url.startsWith('/api/secrets')) {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') calls.push({ url, method, body: JSON.parse(init?.body ?? 'null') });
      return json(secretsStatus, secretsStatus === 200 ? { groq: isSet ? { set: true, ...(withPreview ? { preview: 'gsk_T*****' } : {}) } : { set: false } } : { code: 'dictation.keyInvalid' });
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
const row = (): HTMLElement => document.querySelector<HTMLElement>('.options-secret-status')!;
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

  it('shows the start of a saved key in the field itself (five characters and stars), nothing when none, and stars alone if the console sends no preview', async () => {
    await openOptions(() => state, 'secrets');
    await flush();
    expect(input().placeholder).toBe('');
    expect(row().hidden).toBe(true); // no key: nothing to remove
    document.body.innerHTML = '<div id="overlay" hidden></div>';
    isSet = true;
    await openOptions(() => state, 'secrets');
    await flush();
    expect(input().placeholder).toBe('gsk_T*****');
    expect(input().value).toBe(''); // a placeholder: typing replaces it and it is never sent
    expect(row().hidden).toBe(false);
    expect(document.body.innerHTML).not.toContain(KEY);
    document.body.innerHTML = '<div id="overlay" hidden></div>';
    withPreview = false;
    await openOptions(() => state, 'secrets');
    await flush();
    expect(input().placeholder).toBe('*****');
  });

  it('has an eye that shows and hides what is typed, like a password field, and keeps the keyboard in the field', async () => {
    await openOptions(() => state, 'secrets');
    await flush();
    const eye = document.querySelector<HTMLButtonElement>('button[name="toggleGroqKey"]')!;
    expect(input().type).toBe('password');
    expect(eye.querySelector('svg')!.dataset.icon).toBe('eye');
    type('gsk_abcdef');
    eye.click();
    expect(input().type).toBe('text');
    expect(input().value).toBe('gsk_abcdef');
    expect(eye.querySelector('svg')!.dataset.icon).toBe('eyeOff');
    eye.click();
    expect(input().type).toBe('password');
    expect(eye.dispatchEvent(new MouseEvent('mousedown', { cancelable: true, bubbles: true }))).toBe(false); // the button never takes the focus
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
    expect(input().placeholder).toBe(''); // the key is going away: no start shown
    clear.click(); // second click: undo: the saved key's start is shown again
    expect(input().placeholder).toBe('gsk_T*****');
    expect(status().hidden).toBe(true);
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
