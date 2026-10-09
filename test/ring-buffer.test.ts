import { it, expect } from 'vitest';
import { ByteRing } from '../src/server/pty/ring-buffer';

it('returns everything while under capacity', () => {
  const r = new ByteRing(100);
  r.append(Buffer.from('hello\n'));
  r.append(Buffer.from('world\n'));
  expect(r.snapshot().toString()).toBe('hello\nworld\n');
});
it('keeps only the tail and starts at a line boundary once it wraps', () => {
  const r = new ByteRing(12);
  r.append(Buffer.from('aaaa\nbbbb\ncccc\n'));
  expect(r.snapshot().toString()).toBe('bbbb\ncccc\n');
});
it('never exceeds capacity', () => {
  const r = new ByteRing(8);
  for (let i = 0; i < 100; i++) r.append(Buffer.from('xxxxx\n'));
  expect(r.snapshot().length).toBeLessThanOrEqual(8);
});

const ESC = String.fromCharCode(27);
it('replays terminal modes that were set before the window wrapped (bracketed paste, cursor)', () => {
  const r = new ByteRing(64);
  r.append(Buffer.from(`${ESC}[?2004h${ESC}[?25l`));
  for (let i = 0; i < 20; i++) r.append(Buffer.from(`line ${i}\n`));
  const text = r.snapshot().toString();
  expect(text.startsWith(`${ESC}[?2004h`)).toBe(true);
  expect(text).toContain(`${ESC}[?25l`);
});
it('the last state of a mode wins', () => {
  const r = new ByteRing(32);
  r.append(Buffer.from(`${ESC}[?2004h`));
  r.append(Buffer.from(`${ESC}[?2004l`));
  for (let i = 0; i < 20; i++) r.append(Buffer.from(`line ${i}\n`));
  const text = r.snapshot().toString();
  expect(text).toContain(`${ESC}[?2004l`);
  expect(text).not.toContain(`${ESC}[?2004h`);
});
it('tracks a mode sequence split across two chunks', () => {
  const r = new ByteRing(32);
  r.append(Buffer.from(`${ESC}[?20`));
  r.append(Buffer.from('04h'));
  for (let i = 0; i < 20; i++) r.append(Buffer.from(`line ${i}\n`));
  expect(r.snapshot().toString().startsWith(`${ESC}[?2004h`)).toBe(true);
});
it('appending to a full 4 MiB buffer stays cheap', () => {
  const r = new ByteRing(4 * 1024 * 1024);
  const big = Buffer.alloc(1024 * 1024, 0x61);
  for (let i = 0; i < 5; i++) r.append(big);
  const chunk = Buffer.alloc(200, 0x62);
  const t = performance.now();
  for (let i = 0; i < 2000; i++) r.append(chunk);
  expect(performance.now() - t).toBeLessThan(200);
});

it('resize keeps the tail of what is there, and the new size is the limit from then on; growing it back restores the room', () => {
  const r = new ByteRing(100);
  for (let i = 0; i < 10; i++) r.append(Buffer.from(`line ${i}\n`)); // 70 bytes
  r.resize(20);
  const small = r.snapshot().toString();
  expect(small.length).toBeLessThanOrEqual(20);
  expect(small.endsWith('line 9\n')).toBe(true);
  for (let i = 10; i < 20; i++) r.append(Buffer.from(`line ${i}\n`));
  expect(r.snapshot().length).toBeLessThanOrEqual(20);
  r.resize(100);
  for (let i = 20; i < 30; i++) r.append(Buffer.from(`line ${i}\n`));
  expect(r.snapshot().length).toBeGreaterThan(40); // it grows again
});
