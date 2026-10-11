import { describe, expect, it } from 'vitest';
import { missingChangelog } from '../scripts/check-changelog';

describe('changelog rule', () => {
  it('a commit that changes the product needs a CHANGELOG line; tests, scripts and docs alone do not', () => {
    expect(missingChangelog(['src/ui/options.ts'])).toBe(true);
    expect(missingChangelog(['src/ui/options.ts', 'CHANGELOG.md'])).toBe(false);
    expect(missingChangelog(['catalog/plugins-catalog.json'])).toBe(true);
    expect(missingChangelog(['prompts/main.md'])).toBe(true);
    expect(missingChangelog(['test/a.test.ts', 'scripts/shot.ts', 'package.json'])).toBe(false);
    expect(missingChangelog([])).toBe(false);
  });
});
