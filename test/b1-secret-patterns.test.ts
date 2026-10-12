import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('every call that saves work before a push uses the project\'s secret patterns, not only the global ones (B1)', () => {
  const src = readFileSync(new URL('../src/server/index.ts', import.meta.url), 'utf8');
  expect(src).not.toMatch(/secretPatterns:\s*runtime\.git\.secretPatterns/);
  expect(src.match(/secretPatterns:\s*secretPatterns\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
});
