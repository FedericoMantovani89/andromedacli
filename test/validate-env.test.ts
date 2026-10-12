import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runValidation } from '../src/server/tickets/validate';

let dir: string;
let before: string | undefined;
beforeEach(() => {
  before = process.env.NoDefaultCurrentDirectoryInExePath;
  process.env.NoDefaultCurrentDirectoryInExePath = '1'; // what the console sets for itself at start
  dir = mkdtempSync(join(tmpdir(), 'validate-env-'));
});
afterEach(() => {
  if (before === undefined) delete process.env.NoDefaultCurrentDirectoryInExePath; else process.env.NoDefaultCurrentDirectoryInExePath = before;
  rmSync(dir, { recursive: true, force: true });
});

// A project's own command is written for a plain Windows shell: `mvnw.cmd test` names a file in the project folder with no `.\`.
it('a project command still finds a script in its folder although the console protects its own program search', async () => {
  writeFileSync(join(dir, 'tool.cmd'), '@echo off\r\necho FOUND_IN_CWD\r\n');
  const r = await runValidation({ cwd: dir, command: 'tool.cmd', timeoutMs: 20000 });
  expect(r.tail).toContain('FOUND_IN_CWD');
  expect(r.ok).toBe(true);
});
