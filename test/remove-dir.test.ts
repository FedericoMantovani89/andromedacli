import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeDir } from './git-helpers';

describe('removeDir', () => {
  it('removes a folder with nested files', () => {
    const base = mkdtempSync(join(tmpdir(), 'rmdir-'));
    mkdirSync(join(base, 'a', 'b'), { recursive: true });
    writeFileSync(join(base, 'a', 'b', 'f.txt'), 'x');
    removeDir(base);
    expect(existsSync(base)).toBe(false);
  });

  it('does not throw on a path that does not exist', () => {
    expect(() => removeDir(join(tmpdir(), 'rmdir-missing-' + Date.now()))).not.toThrow();
  });
});
