import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fail = { times: 0, code: 'EPERM', calls: 0 };
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    renameSync: (from: string, to: string): void => {
      fail.calls++;
      if (fail.times > 0) {
        fail.times--;
        const e = new Error('busy') as NodeJS.ErrnoException;
        e.code = fail.code;
        throw e;
      }
      real.renameSync(from, to);
    },
  };
});

import { writeJsonAtomic } from '../src/server/fs-atomic';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fs-atomic-retry-')); fail.times = 0; fail.code = 'EPERM'; fail.calls = 0; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('retries a transient EPERM and then succeeds', () => {
  const file = join(dir, 'a.json');
  fail.times = 2;
  writeJsonAtomic(file, { ok: true });
  expect(fail.calls).toBe(3);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ok: true });
  expect(readdirSync(dir)).toEqual(['a.json']);
});

it('gives up after the last attempt, throws the original error, keeps the old file and leaves no temp file (Review Focus 4)', () => {
  const file = join(dir, 'a.json');
  writeFileSync(file, '{"old":true}');
  fail.times = 99;
  expect(() => writeJsonAtomic(file, { new: true })).toThrow('busy');
  expect(fail.calls).toBe(5);
  expect(readFileSync(file, 'utf8')).toBe('{"old":true}');
  expect(readdirSync(dir)).toEqual(['a.json']);
});

it('does not retry an error that is not a busy-file error', () => {
  fail.times = 99;
  fail.code = 'ENOSPC';
  expect(() => writeJsonAtomic(join(dir, 'a.json'), 1)).toThrow('busy');
  expect(fail.calls).toBe(1);
});
