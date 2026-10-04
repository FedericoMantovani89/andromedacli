export const SLUG_MIN = 3;
export const SLUG_MAX = 40;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Generic words, English and Italian; "-<digits>" variants are generic too (configurable in Phase 6).
const GENERIC = ['agent', 'agente', 'task', 'test', 'prova', 'nuovo', 'nuova', 'fix', 'work', 'lavoro', 'temp'];
// Windows device names cannot be file or folder names, and the slug becomes both later (ticket folder, worktree).
const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const GENERIC_RE = new RegExp(`^(${GENERIC.join('|')})(-\\d+)?$`);

export type SlugResult =
  | { ok: true; slug: string }
  | {
      ok: false;
      code: 'slug.missing' | 'slug.format' | 'slug.length' | 'slug.generic' | 'slug.reserved' | 'slug.duplicate';
      params: Record<string, string | number>;
    };

/** SPEC 6.2: format, length, not generic, unique. Accents are transliterated; the language is not checked. */
export function validateSlug(raw: unknown, existing: readonly string[]): SlugResult {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, code: 'slug.missing', params: {} };
  const slug = raw.trim().normalize('NFD').replace(/\p{M}/gu, '');
  if (!SLUG_RE.test(slug)) return { ok: false, code: 'slug.format', params: {} };
  if (slug.length < SLUG_MIN || slug.length > SLUG_MAX) {
    return { ok: false, code: 'slug.length', params: { min: SLUG_MIN, max: SLUG_MAX } };
  }
  if (RESERVED_RE.test(slug)) return { ok: false, code: 'slug.reserved', params: { slug } };
  if (GENERIC_RE.test(slug)) return { ok: false, code: 'slug.generic', params: { slug } };
  if (existing.includes(slug)) return { ok: false, code: 'slug.duplicate', params: { slug } };
  return { ok: true, slug };
}
