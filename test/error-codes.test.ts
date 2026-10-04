import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { USER_ERROR_CODES } from '../src/shared/protocol';
import { parseProperties } from '../src/server/properties';
import { checkErrorCodes } from '../src/shared/i18n-checks';

const root = join(__dirname, '..');
// Codes the UI shows with the generic message on purpose: they are not something the user can act on.
const SILENT = new Set(['forbidden', 'unauthorized', 'not_found', 'bad_request', 'internal', 'config.invalid', 'config.unreadable']);

it('every error code the server can send is either user-facing or deliberately silent', () => {
  const sources = ['src/server/http.ts', 'src/shared/slug.ts'].map((f) => readFileSync(join(root, f), 'utf8')).join('\n');
  const codes = new Set<string>();
  for (const m of sources.matchAll(/fail\(res,\s*\d+,\s*'([\w.]+)'/g)) codes.add(m[1]!);
  for (const m of sources.matchAll(/code: '([\w.]+)'/g)) codes.add(m[1]!);
  const unknown = [...codes].filter((c) => !USER_ERROR_CODES.includes(c as never) && !SILENT.has(c));
  expect(unknown).toEqual([]);
});
it('every user-facing error code has a translation key', () => {
  const en = parseProperties(readFileSync(join(root, 'src', 'i18n', 'messages_en.properties'), 'utf8'));
  expect(checkErrorCodes(en, USER_ERROR_CODES)).toEqual([]);
  expect(checkErrorCodes({}, ['slug.format'])).toEqual(['en: no key "error.slug.format" for error code "slug.format"']);
});
