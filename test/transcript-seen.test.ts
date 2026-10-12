import { expect, it } from 'vitest';
import { MAX_SEEN, remember } from '../src/server/claude-code/transcript';

it('remembers the ids it was given', () => {
  const seen = new Set<string>();
  remember(seen, 'a');
  expect(seen.has('a')).toBe(true);
});

it('keeps at most MAX_SEEN ids and drops the oldest first (B8)', () => {
  const seen = new Set<string>();
  for (let i = 0; i < MAX_SEEN + 10; i++) remember(seen, `id-${i}`);
  expect(seen.size).toBe(MAX_SEEN);
  expect(seen.has('id-0')).toBe(false);
  expect(seen.has(`id-${MAX_SEEN + 9}`)).toBe(true);
});
