import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { hardenExecutableSearch } from '../src/server/exe-search';
import { git } from '../src/server/git/git';

let dir: string;
let before: string | undefined;
beforeEach(() => {
  before = process.env.NoDefaultCurrentDirectoryInExePath;
  delete process.env.NoDefaultCurrentDirectoryInExePath;
  dir = mkdtempSync(join(tmpdir(), 'exe-search-'));
});
afterEach(() => {
  if (before === undefined) delete process.env.NoDefaultCurrentDirectoryInExePath; else process.env.NoDefaultCurrentDirectoryInExePath = before;
  rmSync(dir, { recursive: true, force: true });
});

it('a git.exe in the working folder is not run once the search is hardened', async () => {
  copyFileSync(process.execPath, join(dir, 'git.exe')); // a stand-in: `git.exe --version` would print the Node version
  hardenExecutableSearch();
  expect(process.env.NoDefaultCurrentDirectoryInExePath).toBe('1');
  const r = await git(dir, ['--version']);
  expect(r.stdout).toMatch(/^git version /);
});
