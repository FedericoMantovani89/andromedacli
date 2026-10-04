import { it, expect, vi } from 'vitest';
import { createTranslator } from '../src/shared/i18n';

const en = { 'a.hello': 'Hello {name}', 'n.one': '{count} agent', 'n.other': '{count} agents', 'only.en': 'English only' };
const it_ = { 'a.hello': 'Ciao {name}', 'n.one': '{count} agente', 'n.other': '{count} agenti' };

it('substitutes named placeholders', () => {
  const t = createTranslator({ lang: 'it', messages: it_, fallback: en });
  expect(t('a.hello', { name: 'Fede' })).toBe('Ciao Fede');
});
it('selects plural forms with Intl.PluralRules', () => {
  const t = createTranslator({ lang: 'it', messages: it_, fallback: en });
  expect(t('n', { count: 1 })).toBe('1 agente');
  expect(t('n', { count: 3 })).toBe('3 agenti');
  expect(t('n', { count: 0 })).toBe('0 agenti');
});
it('falls back to English, then to the key, and reports misses', () => {
  const onMissing = vi.fn();
  const t = createTranslator({ lang: 'it', messages: it_, fallback: en, onMissing });
  expect(t('only.en')).toBe('English only');
  expect(t('nope.nothing')).toBe('nope.nothing');
  expect(onMissing).toHaveBeenCalledWith('only.en');
  expect(onMissing).toHaveBeenCalledWith('nope.nothing');
});
it('leaves an unknown placeholder visible instead of printing undefined', () => {
  const t = createTranslator({ lang: 'en', messages: en });
  expect(t('a.hello')).toBe('Hello {name}');
});
