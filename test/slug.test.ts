import { it, expect } from 'vitest';
import { validateSlug } from '../src/shared/slug';

const ok = (raw: string, existing: string[] = []) => validateSlug(raw, existing);
it('accepts a good slug', () => expect(ok('fix-login-timeout')).toEqual({ ok: true, slug: 'fix-login-timeout' }));
it('transliterates accents and trims, then validates', () => {
  expect(ok(' attività-login ')).toEqual({ ok: true, slug: 'attivita-login' });
  expect(ok('correggi-timeout-login')).toEqual({ ok: true, slug: 'correggi-timeout-login' });
});
it('rejects missing', () => {
  for (const v of [undefined, null, '', '   ', 42]) expect(validateSlug(v, [])).toMatchObject({ ok: false, code: 'slug.missing' });
});
it('rejects bad format', () => {
  for (const v of ['Fix-Login', 'fix login', '-fix-login', 'fix-login-', 'fix--login', 'fix_login', 'fix.login'])
    expect(ok(v)).toMatchObject({ ok: false, code: 'slug.format' });
});
it('rejects bad length with the limits as params', () => {
  expect(ok('ab')).toEqual({ ok: false, code: 'slug.length', params: { min: 3, max: 40 } });
  expect(ok('a'.repeat(41))).toEqual({ ok: false, code: 'slug.length', params: { min: 3, max: 40 } });
  expect(ok('a'.repeat(40)).ok).toBe(true);
});
it('rejects generic names, numbered variants included, in both languages', () => {
  for (const v of ['agent', 'agent-1', 'task', 'test', 'prova', 'nuovo', 'fix', 'work', 'temp', 'agente', 'task-12', 'prova-3'])
    expect(ok(v)).toMatchObject({ ok: false, code: 'slug.generic', params: { slug: v } });
});
it('rejects duplicates', () => {
  expect(ok('fix-login', ['fix-login'])).toEqual({ ok: false, code: 'slug.duplicate', params: { slug: 'fix-login' } });
});

it('rejects Windows reserved device names, which would break folders and branches later', () => {
  for (const v of ['con', 'nul', 'aux', 'prn', 'com1', 'lpt9'])
    expect(ok(v)).toMatchObject({ ok: false, code: 'slug.reserved', params: { slug: v } });
  expect(ok('console-fix').ok).toBe(true);
});
