import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHandoverNote } from '../src/server/tickets/handover';
import { removeDir } from './git-helpers';

let root: string;
let wt: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'handover-'));
  wt = join(root, 'wt');
  outside = join(root, 'outside');
  mkdirSync(join(wt, '.andromedacli'), { recursive: true });
  mkdirSync(outside);
});
afterEach(() => { removeDir(root); });

const note = (text: string): void => writeFileSync(join(wt, '.andromedacli', 'handover.md'), text);

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

  it('refuses a .andromedacli junction pointing outside the worktree', () => {
    writeFileSync(join(outside, 'handover.md'), 'secret');
    rmSync(join(wt, '.andromedacli'), { recursive: true });
    symlinkSync(outside, join(wt, '.andromedacli'), 'junction');
    expect(readHandoverNote(wt)).toBeUndefined();
  });

  it('accepts a .andromedacli junction that stays inside the worktree', () => {
    mkdirSync(join(wt, 'real'));
    writeFileSync(join(wt, 'real', 'handover.md'), 'inside');
    rmSync(join(wt, '.andromedacli'), { recursive: true });
    symlinkSync(join(wt, 'real'), join(wt, '.andromedacli'), 'junction');
    expect(readHandoverNote(wt)).toBe('inside');
  });
});
