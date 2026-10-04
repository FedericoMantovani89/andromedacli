import { it, expect, vi } from 'vitest';
import { mkdtempSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadingStore } from '../src/server/reading/store';

const dir = () => mkdtempSync(join(tmpdir(), 'reading-'));

it('keeps the answers in order, numbered per agent', () => {
  const s = new ReadingStore(dir());
  s.add('fix-login', 'first');
  s.add('fix-login', 'second');
  s.add('other-job', 'elsewhere');
  expect(s.list('fix-login').map((e) => [e.n, e.text])).toEqual([[1, 'first'], [2, 'second']]);
  expect(s.list('other-job').map((e) => e.n)).toEqual([1]);
});
it('keeps only the last 50 entries', () => {
  const s = new ReadingStore(dir());
  for (let i = 1; i <= 51; i++) s.add('fix-login', `answer ${i}`);
  const list = s.list('fix-login');
  expect(list).toHaveLength(50);
  expect(list[0]!.n).toBe(2);
  expect(list.at(-1)!.n).toBe(51);
});
it('truncates a huge answer and says so', () => {
  const s = new ReadingStore(dir(), { maxTextBytes: 1000 });
  s.add('fix-login', 'x'.repeat(5000));
  const e = s.list('fix-login')[0]!;
  expect(e.truncated).toBe(true);
  expect(Buffer.byteLength(e.text)).toBeLessThanOrEqual(1000);
  s.add('fix-login', 'short');
  expect(s.list('fix-login')[1]!.truncated).toBeUndefined();
});
it('ignores empty or blank answers (no blank entries)', () => {
  const s = new ReadingStore(dir());
  s.add('fix-login', '');
  s.add('fix-login', '   \n  ');
  expect(s.list('fix-login')).toEqual([]);
});
it('survives a restart: a new store over the same folder lists the saved entries and keeps numbering', () => {
  const d = dir();
  const a = new ReadingStore(d);
  a.add('fix-login', 'one'); a.add('fix-login', 'two');
  const b = new ReadingStore(d);
  expect(b.list('fix-login').map((e) => e.text)).toEqual(['one', 'two']);
  b.add('fix-login', 'three');
  expect(b.list('fix-login').map((e) => e.n)).toEqual([1, 2, 3]);
});
it('rotates the file when it grows past the limit, keeping the latest entries', () => {
  const d = dir();
  const s = new ReadingStore(d, { maxFileBytes: 4000 });
  for (let i = 1; i <= 60; i++) s.add('fix-login', `answer number ${i} ${'y'.repeat(100)}`);
  const file = join(d, 'fix-login.jsonl');
  expect(statSync(file).size).toBeLessThan(4000 + 300);
  const again = new ReadingStore(d, { maxFileBytes: 4000 });
  expect(again.list('fix-login').at(-1)!.text).toContain('answer number 60');
});
it('an unknown agent lists nothing, and an unsafe name never touches the disk', () => {
  const d = dir();
  const s = new ReadingStore(d);
  expect(s.list('ghost-job')).toEqual([]);
  s.add('../escape', 'x');
  s.add('a/b', 'x');
  expect(existsSync(join(d, '..', 'escape.jsonl'))).toBe(false);
  expect(s.list('../escape')).toEqual([]);
});
it('notifies listeners with each new entry', () => {
  const s = new ReadingStore(dir());
  const cb = vi.fn();
  s.on(cb);
  s.add('fix-login', 'hello');
  expect(cb).toHaveBeenCalledWith('fix-login', expect.objectContaining({ n: 1, text: 'hello' }));
});
