import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_CORRUPT_COPIES, readJsonState, setAside } from '../src/server/json-file';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'json-state-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const at = (s: number): (() => Date) => () => new Date(Date.UTC(2026, 9, 12, 10, 0, s));

describe('readJsonState', () => {
  it('reads a good file', () => {
    const f = join(dir, 'a.json');
    writeFileSync(f, '{"a":1}');
    expect(readJsonState(f)).toEqual({ status: 'ok', value: { a: 1 } });
  });

  it('says missing for a file that is not there, and does not report', () => {
    const report = vi.fn();
    expect(readJsonState(join(dir, 'nope.json'), report)).toEqual({ status: 'missing' });
    expect(report).not.toHaveBeenCalled();
  });

  it('moves a damaged file aside, reports it once, and the original name is free', () => {
    const f = join(dir, 'a.json');
    writeFileSync(f, '{nope');
    const report = vi.fn();
    const r = readJsonState(f, report, at(1));
    expect(r.status).toBe('corrupt');
    expect(report).toHaveBeenCalledTimes(1);
    const movedTo = join(dir, 'a.json.corrupt-20261012T100001Z');
    expect(report).toHaveBeenCalledWith(f, movedTo);
    expect(r).toEqual({ status: 'corrupt', movedTo });
    expect(existsSync(f)).toBe(false);
    expect(existsSync(movedTo)).toBe(true);
    expect(readJsonState(f, report)).toEqual({ status: 'missing' });
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('treats an empty file as damaged', () => {
    const f = join(dir, 'a.json');
    writeFileSync(f, '');
    expect(readJsonState(f, undefined, at(2)).status).toBe('corrupt');
  });

  it('keeps both copies when two files are set aside in the same second (Review Focus 3)', () => {
    const f = join(dir, 'a.json');
    writeFileSync(f, 'first');
    readJsonState(f, undefined, at(3));
    writeFileSync(f, 'second');
    readJsonState(f, undefined, at(3));
    expect(readdirSync(dir).filter((n) => n.startsWith('a.json.corrupt-')).length).toBe(2);
  });

  it(`keeps at most ${MAX_CORRUPT_COPIES} copies, dropping the oldest`, () => {
    const f = join(dir, 'a.json');
    for (let s = 10; s < 10 + MAX_CORRUPT_COPIES + 2; s++) { writeFileSync(f, `bad ${s}`); readJsonState(f, undefined, at(s)); }
    const copies = readdirSync(dir).filter((n) => n.startsWith('a.json.corrupt-')).sort();
    expect(copies.length).toBe(MAX_CORRUPT_COPIES);
    expect(copies[0]).toBe('a.json.corrupt-20261012T100012Z');
  });
});

describe('setAside', () => {
  it('moves a file that parses but has the wrong shape, and reports it', () => {
    const f = join(dir, 'agents.json');
    writeFileSync(f, '{}');
    const report = vi.fn();
    const movedTo = setAside(f, report, at(5));
    expect(movedTo).toBe(join(dir, 'agents.json.corrupt-20261012T100005Z'));
    expect(report).toHaveBeenCalledWith(f, movedTo);
    expect(existsSync(f)).toBe(false);
  });
  it('returns undefined when the file cannot be moved (it is not there)', () => {
    expect(setAside(join(dir, 'nope.json'))).toBeUndefined();
  });
});
