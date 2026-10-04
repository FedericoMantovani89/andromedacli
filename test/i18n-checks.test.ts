import { it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkBundles } from '../src/shared/i18n-checks';
import { parseProperties } from '../src/server/properties';

const en = { 'a.x': 'Hi {name}', 'n.one': '{count} a', 'n.other': '{count} as', 'unused.k': 'u' };

it('passes identical bundles with all keys used', () => {
  const it_ = { 'a.x': 'Ciao {name}', 'n.one': '{count} a', 'n.other': '{count} as', 'unused.k': 'u' };
  expect(checkBundles({ en, it: it_ }, new Set(['a.x', 'n', 'unused.k']), [])).toEqual([]);
});
it('reports missing and extra keys in other languages', () => {
  const problems = checkBundles({ en, it: { 'a.x': 'Ciao {name}', 'extra.k': 'e' } }, new Set(['a.x', 'n', 'unused.k', 'extra.k']), []);
  expect(problems.join('\n')).toMatch(/it: missing key "n.one"/);
  expect(problems.join('\n')).toMatch(/it: extra key "extra.k"/);
});
it('reports placeholder mismatches', () => {
  const problems = checkBundles({ en, it: { ...en, 'a.x': 'Ciao' } }, new Set(['a.x', 'n', 'unused.k']), []);
  expect(problems.join('\n')).toMatch(/it: "a.x" placeholders differ/);
});
it('reports a plural without its .other twin', () => {
  const bad = { 'p.one': '{count} x' };
  expect(checkBundles({ en: bad }, new Set(['p']), []).join('\n')).toMatch(/"p.one" has no "p.other"/);
});
it('reports unused keys but honours dynamic prefixes', () => {
  const bundle = { 'state.running': 'R', 'dead.key': 'D' };
  expect(checkBundles({ en: bundle }, new Set(), ['state.'])).toEqual(['en: unused key "dead.key"']);
});
it('the shipped bundles parse and have the same keys', () => {
  const dir = join(__dirname, '..', 'src', 'i18n');
  const bundles: Record<string, Record<string, string>> = {};
  for (const f of readdirSync(dir)) {
    const m = /^messages_(\w+)\.properties$/.exec(f);
    if (m) bundles[m[1]!] = parseProperties(readFileSync(join(dir, f), 'utf8'));
  }
  expect(Object.keys(bundles).sort()).toEqual(['en', 'it']);
  const used = new Set(Object.keys(bundles.en!));
  expect(checkBundles(bundles, used, [])).toEqual([]);
});

it('reports a key used in code that no bundle defines (a typo would show the raw key)', () => {
  const problems = checkBundles({ en }, new Set(['a.x', 'n', 'unused.k', 'panel.mian']), []);
  expect(problems).toEqual(['en: key "panel.mian" is used in code but not defined']);
});
