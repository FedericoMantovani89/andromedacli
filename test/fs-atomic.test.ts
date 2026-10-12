import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { writeJsonAtomic } from '../src/server/fs-atomic';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fs-atomic-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('writes the value and leaves only the target file behind', () => {
  const file = join(dir, 'a.json');
  writeJsonAtomic(file, { a: 1 });
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 1 });
  expect(readdirSync(dir)).toEqual(['a.json']);
});

it('replaces an existing file', () => {
  const file = join(dir, 'a.json');
  writeJsonAtomic(file, { a: 1 });
  writeJsonAtomic(file, { a: 2 });
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 2 });
});

it('creates the folder of the file', () => {
  const file = join(dir, 'x', 'y', 'a.json');
  writeJsonAtomic(file, []);
  expect(readFileSync(file, 'utf8')).toBe('[]\n');
});
