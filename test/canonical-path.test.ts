import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { canonicalFolder } from '../src/server/canonical-path';

it('returns the long form of an existing folder and a missing one as given', () => {
  const d = mkdtempSync(join(tmpdir(), 'canon-'));
  mkdirSync(join(d, 'Some Long Folder Name'));
  expect(canonicalFolder(join(d, 'Some Long Folder Name')).toLowerCase()).toContain('some long folder name');
  expect(canonicalFolder(join(d, 'missing'))).toBe(join(d, 'missing'));
});
