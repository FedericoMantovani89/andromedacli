import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { removeStaleTmp } from '../src/server/fs-atomic';
import { removeDir } from './git-helpers';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'stale-')); });
afterEach(() => removeDir(dir));

it('removes old temp files and nothing else', () => {
  const old = join(dir, 'a.json.tmp-123-4');
  const fresh = join(dir, 'b.json.tmp-123-5');
  const real = join(dir, 'c.json');
  const other = join(dir, 'd.json.tmp');
  for (const f of [old, fresh, real, other]) writeFileSync(f, 'x');
  const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
  utimesSync(old, twoHoursAgo, twoHoursAgo);
  utimesSync(real, twoHoursAgo, twoHoursAgo);
  expect(removeStaleTmp(dir)).toBe(1);
  expect(existsSync(old)).toBe(false);
  expect([fresh, real, other].every(existsSync)).toBe(true);
});
it('a missing folder is not an error', () => {
  expect(removeStaleTmp(join(dir, 'nope'))).toBe(0);
});
