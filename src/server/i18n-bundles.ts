import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resourcePath } from './paths';
import { parseProperties } from './properties';

export type Bundles = Map<string, Record<string, string>>;

export const defaultI18nDir = (): string => resourcePath('src', 'i18n');

/** Loads every messages_<lang>.properties; a new language is just a new file (SPEC 5.9). */
export function loadBundles(dir: string = defaultI18nDir()): Bundles {
  const bundles: Bundles = new Map();
  for (const f of readdirSync(dir)) {
    const m = /^messages_(\w+)\.properties$/.exec(f);
    if (m) bundles.set(m[1]!, parseProperties(readFileSync(join(dir, f), 'utf8')));
  }
  return bundles;
}

/** Payload of GET /i18n/<lang>: the selected bundle plus English as fallback. */
export function bundlePayload(bundles: Bundles, lang: string):
  { lang: string; messages: Record<string, string>; fallback: Record<string, string> } | undefined {
  const messages = bundles.get(lang);
  if (!messages) return undefined;
  return { lang, messages, fallback: lang === 'en' ? {} : (bundles.get('en') ?? {}) };
}
