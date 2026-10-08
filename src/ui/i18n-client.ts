import { createTranslator, type Translate } from '../shared/i18n';
import { api } from './api';

interface Payload { lang: string; messages: Record<string, string>; fallback: Record<string, string> }

const missing = new Set<string>();
let translate: Translate = (key) => key;
let current = 'en';

/** Resolves "auto" to the browser language when supported, otherwise English (SPEC 5.9). */
export function resolveLanguage(setting: string, supported: readonly string[]): string {
  if (supported.includes(setting)) return setting;
  const browser = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return supported.includes(browser) ? browser : 'en';
}

/** Name of a language written in that language ("Italiano"), for the language selector. */
export function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    return name ? name.charAt(0).toLocaleUpperCase(code) + name.slice(1) : code;
  } catch {
    return code;
  }
}

/** Texts without a session: used to explain a refused token. Tries the browser language, then English. */
export async function initI18nAnonymous(): Promise<void> {
  const browser = (navigator.language || 'en').slice(0, 2).toLowerCase();
  try { await initI18n(browser); } catch { await initI18n('en'); }
}

export const t: Translate = (key, params) => translate(key, params);
export const language = (): string => current;

/** Marks a key that is stored in data and translated later, so the unused-key check can see it. */
export const k = (key: string): string => key;

async function load(lang: string): Promise<void> {
  const res = await api<Payload>(`/i18n/${lang}`);
  if (res.status !== 200) throw new Error(`i18n bundle ${lang} unavailable`);
  current = lang;
  translate = createTranslator({
    lang, messages: res.body.messages, fallback: res.body.fallback,
    onMissing: (key) => {
      if (!missing.has(key)) { missing.add(key); console.warn(`i18n: missing key "${key}" for ${lang}`); }
    },
  });
}

export async function initI18n(lang: string): Promise<void> {
  await load(lang);
  retranslate();
}

/** Switches language at runtime without reloading the page (SPEC 5.9). */
export async function setLanguage(lang: string): Promise<void> {
  await load(lang);
  document.documentElement.lang = lang;
  retranslate();
  window.dispatchEvent(new CustomEvent('languagechange'));
}

/** Sets an element's text from a key and remembers it so a language change can redo it. */
export function bindText(el: HTMLElement, key: string, params?: Record<string, string | number>): void {
  el.dataset.i18n = key;
  if (params) el.dataset.i18nParams = JSON.stringify(params);
  else delete el.dataset.i18nParams;
  el.textContent = t(key, params);
}

/** Sets an input's placeholder from a key and remembers it for language changes. */
export function setPlaceholder(el: HTMLInputElement, key: string): void {
  el.dataset.i18nPlaceholder = key;
  el.placeholder = t(key);
}

/** Sets an element's tooltip and accessible name from a key and remembers it for language changes. */
export function setTitle(el: HTMLElement, key: string, params?: Record<string, string | number>): void {
  el.dataset.i18nTitle = key;
  if (params) el.dataset.i18nTitleParams = JSON.stringify(params);
  else delete el.dataset.i18nTitleParams;
  applyTitle(el, t(key, params));
}

/** An (i) icon draws its own tooltip from aria-label (CSS); every other element uses the native title. */
function applyTitle(el: HTMLElement, text: string): void {
  if (el.classList.contains('info-icon')) el.removeAttribute('title');
  else el.title = text;
  el.setAttribute('aria-label', text);
}

export function retranslate(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder!);
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) applyTitle(el, t(el.dataset.i18nTitle!, el.dataset.i18nTitleParams ? (JSON.parse(el.dataset.i18nTitleParams) as Record<string, string | number>) : undefined));
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const params = el.dataset.i18nParams ? (JSON.parse(el.dataset.i18nParams) as Record<string, string | number>) : undefined;
    el.textContent = t(el.dataset.i18n!, params);
  }
}
