import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readJsonFile } from '../src/server/json-file';

const dir = mkdtempSync(join(tmpdir(), 'h-json-'));

it('returns the parsed value of a valid file', () => {
  writeFileSync(join(dir, 'ok.json'), '{"a":[1,2]}');
  expect(readJsonFile(join(dir, 'ok.json'))).toEqual({ a: [1, 2] });
});
it('returns undefined for a missing file and for damaged JSON, and never throws', () => {
  writeFileSync(join(dir, 'bad.json'), '{"a":');
  expect(readJsonFile(join(dir, 'missing.json'))).toBeUndefined();
  expect(readJsonFile(join(dir, 'bad.json'))).toBeUndefined();
  expect(readJsonFile(dir)).toBeUndefined(); // a folder is not a file
});
it('a file that holds null is null, not undefined (callers tell "absent" from "empty")', () => {
  writeFileSync(join(dir, 'null.json'), 'null');
  expect(readJsonFile(join(dir, 'null.json'))).toBeNull();
});
