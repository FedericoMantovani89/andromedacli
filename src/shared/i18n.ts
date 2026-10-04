export type Messages = Record<string, string>;
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Builds t(key, params): selected language -> fallback -> the key itself. Plurals use `.one`/`.other`. */
export function createTranslator(opts: {
  lang: string; messages: Messages; fallback?: Messages; onMissing?: (key: string) => void;
}): Translate {
  const rules = new Intl.PluralRules(opts.lang);
  const lookup = (key: string): string | undefined => opts.messages[key] ?? opts.fallback?.[key];
  return (key, params) => {
    let resolved = key;
    if (params && typeof params.count === 'number') {
      const form = rules.select(params.count) === 'one' ? 'one' : 'other';
      if (lookup(`${key}.${form}`) !== undefined) resolved = `${key}.${form}`;
    }
    let text = opts.messages[resolved];
    if (text === undefined) {
      opts.onMissing?.(resolved);
      text = opts.fallback?.[resolved];
    }
    if (text === undefined) return resolved;
    return text.replace(/\{(\w+)\}/g, (m, name) => (params && name in params ? String(params[name]) : m));
  };
}
