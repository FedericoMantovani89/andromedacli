import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createCrashLog, installProcessGuards } from '../src/server/crash-log';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'crash-log-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const lines = (file: string): Record<string, unknown>[] => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

it('writes one JSON line with the kind, the message and a short stack', () => {
  const file = join(dir, 'errors.log');
  const log = createCrashLog(file, { now: () => 1_000 });
  log('unhandledRejection', new Error('boom'));
  const [l] = lines(file);
  expect(l).toMatchObject({ kind: 'unhandledRejection', message: 'boom' });
  expect(String(l?.stack)).toContain('boom');
  expect(String(l?.stack).length).toBeLessThanOrEqual(4096);
});

it('describes a reason that is not an Error', () => {
  const file = join(dir, 'errors.log');
  createCrashLog(file)('unhandledRejection', 'plain text');
  expect(lines(file)[0]?.message).toBe('plain text');
});

it('writes at most 20 lines in a minute and then says how many it skipped', () => {
  const file = join(dir, 'errors.log');
  let t = 0;
  const log = createCrashLog(file, { now: () => t });
  for (let i = 0; i < 30; i++) log('unhandledRejection', new Error(`e${i}`));
  expect(lines(file).length).toBe(20);
  t = 61_000;
  log('unhandledRejection', new Error('later'));
  const all = lines(file);
  expect(all.some((l) => l.kind === 'skipped' && l.count === 10)).toBe(true);
  expect(all[all.length - 1]?.message).toBe('later');
});

it('rotates the file to errors.log.1 above the size limit', () => {
  const file = join(dir, 'errors.log');
  const log = createCrashLog(file, { maxBytes: 200 });
  for (let i = 0; i < 6; i++) log('unhandledRejection', new Error('x'.repeat(80)));
  expect(existsSync(`${file}.1`)).toBe(true);
  expect(lines(file).length).toBeLessThan(6); // the older lines moved to errors.log.1
  expect(statSync(file).size).toBeGreaterThan(0);
});

it('installProcessGuards adds one listener, once per file, and the remover takes it off', () => {
  const file = join(dir, 'errors.log');
  const before = process.listenerCount('unhandledRejection');
  const off = installProcessGuards(file);
  installProcessGuards(file);
  expect(process.listenerCount('unhandledRejection')).toBe(before + 1);
  off();
  expect(process.listenerCount('unhandledRejection')).toBe(before);
});
