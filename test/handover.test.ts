import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHandoverNote } from '../src/server/tickets/handover';

let root: string;
let wt: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'handover-'));
  wt = join(root, 'wt');
  outside = join(root, 'outside');
  mkdirSync(join(wt, '.console'), { recursive: true });
  mkdirSync(outside);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const note = (text: string): void => writeFileSync(join(wt, '.console', 'handover.md'), text);

/** True when a file symlink can be created on this account (Windows needs a privilege for it). */
function canSymlinkFile(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'handover-probe-'));
  try {
    writeFileSync(join(dir, 't'), 'x');
    symlinkSync(join(dir, 't'), join(dir, 'l'), 'file');
    return true;
  } catch { return false; } finally { rmSync(dir, { recursive: true, force: true }); }
}
const symlinkOk = canSymlinkFile();

describe('readHandoverNote', () => {
  it('returns undefined when there is no file', () => {
    expect(readHandoverNote(wt)).toBeUndefined();
    expect(readHandoverNote(join(root, 'nowhere'))).toBeUndefined();
  });

  it('reads a normal file, trimmed', () => {
    note('\n  done: A\n  missing: B  \n');
    expect(readHandoverNote(wt)).toBe('done: A\n  missing: B');
  });

  it('an empty note is undefined', () => {
    note('  \n ');
    expect(readHandoverNote(wt)).toBeUndefined();
  });

  it('refuses a file over 64 KiB', () => {
    note('x'.repeat(64 * 1024 + 1));
    expect(readHandoverNote(wt)).toBeUndefined();
    note('x'.repeat(64 * 1024));
    expect(readHandoverNote(wt)?.length).toBe(4000);
  });

  it('truncates to 4000 characters', () => {
    note('y'.repeat(10_000));
    expect(readHandoverNote(wt)).toBe('y'.repeat(4000));
  });

  it('truncates multi-byte text to 4000 characters, not bytes', () => {
    note('è'.repeat(5000));
    expect(readHandoverNote(wt)).toBe('è'.repeat(4000));
  });

  // Skipped when this Windows account may not create file symlinks (EPERM).
  it.skipIf(!symlinkOk)('refuses a symlink file pointing outside', () => {
    writeFileSync(join(outside, 'secret.md'), 'secret');
    symlinkSync(join(outside, 'secret.md'), join(wt, '.console', 'handover.md'), 'file');
    expect(readHandoverNote(wt)).toBeUndefined();
  });

  it('refuses a .console junction pointing outside the worktree', () => {
    writeFileSync(join(outside, 'handover.md'), 'secret');
    rmSync(join(wt, '.console'), { recursive: true });
    symlinkSync(outside, join(wt, '.console'), 'junction');
    expect(readHandoverNote(wt)).toBeUndefined();
  });

  it('accepts a .console junction that stays inside the worktree', () => {
    mkdirSync(join(wt, 'real'));
    writeFileSync(join(wt, 'real', 'handover.md'), 'inside');
    rmSync(join(wt, '.console'), { recursive: true });
    symlinkSync(join(wt, 'real'), join(wt, '.console'), 'junction');
    expect(readHandoverNote(wt)).toBe('inside');
  });
});
