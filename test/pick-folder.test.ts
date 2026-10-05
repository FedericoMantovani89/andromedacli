// The native "choose a folder" window: the server runs on the user's own machine, so it can open one.
import { expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createFolderPicker, PICK_SCRIPT, type PickRunner } from '../src/server/pick-folder';
import { autoClose, bootServer, req, ui } from './helpers';

vi.setConfig({ testTimeout: 30_000 });
autoClose();

const decode = (encoded: string): string => Buffer.from(encoded, 'base64').toString('utf16le');
const picker = (run: PickRunner, platform: NodeJS.Platform = 'win32') => createFolderPicker({ title: () => 'Choose a project', platform, run });

it('opens PowerShell in single-threaded mode with the script encoded, and the title only in the environment', async () => {
  const seen: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const pick = picker(async (file, args, env) => { seen.push({ file, args, env }); return { code: 0, stdout: 'D:\\work\\shop-api\r\n' }; });
  await pick();
  expect(seen).toHaveLength(1);
  expect(seen[0]!.file).toBe('powershell.exe');
  expect(seen[0]!.args).toEqual(expect.arrayContaining(['-NoProfile', '-STA', '-EncodedCommand']));
  const script = decode(seen[0]!.args[seen[0]!.args.indexOf('-EncodedCommand') + 1]!);
  expect(script).toContain('System.Windows.Forms.FolderBrowserDialog');
  expect(script).toContain('$env:CONSOLE_PICK_TITLE');
  expect(script).not.toContain('Choose a project'); // the title travels as data, never inside the script
  expect(seen[0]!.env.CONSOLE_PICK_TITLE).toBe('Choose a project');
});

it.skipIf(process.platform !== 'win32')('the script is valid PowerShell (read by the real parser, never run: no window opens)', () => {
  const encoded = Buffer.from(PICK_SCRIPT, 'utf16le').toString('base64');
  const check = "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($env:SCRIPT_B64)), [ref]$null, [ref]$e); $e.Count";
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', check], { env: { ...process.env, SCRIPT_B64: encoded }, encoding: 'utf8', timeout: 60_000 });
  expect(out.trim()).toBe('0'); // zero syntax errors
});

it('answers the chosen folder, trimmed, when it is an absolute path', async () => {
  const pick = picker(async () => ({ code: 0, stdout: '  D:\\work\\shop-api \r\n' }));
  expect(await pick()).toEqual({ status: 'picked', path: 'D:\\work\\shop-api' });
});

it('answers cancelled when the window was closed (no output), and when the output is not a path', async () => {
  expect(await picker(async () => ({ code: 0, stdout: '' }))()).toEqual({ status: 'cancelled' });
  expect(await picker(async () => ({ code: 0, stdout: 'not a path\r\n' }))()).toEqual({ status: 'cancelled' });
});

it('answers unavailable off Windows and when PowerShell cannot be started, never an error', async () => {
  const never = vi.fn();
  expect(await picker(never as unknown as PickRunner, 'linux')()).toEqual({ status: 'unavailable', reason: 'unsupported_platform' });
  expect(never).not.toHaveBeenCalled();
  const broken = await picker(async () => { throw new Error('spawn powershell.exe ENOENT'); })();
  expect(broken).toMatchObject({ status: 'unavailable', reason: 'spawn_failed' });
  // The script itself failing (a non-zero exit) is not "the user cancelled".
  expect(await picker(async () => ({ code: 1, stdout: '' }))()).toEqual({ status: 'unavailable', reason: 'failed' });
});

it('ignores a byte-order mark in front of the path', async () => {
  const pick = picker(async () => ({ code: 0, stdout: `${String.fromCharCode(0xfeff)}D:\\work\\bom\r\n` }));
  expect(await pick()).toEqual({ status: 'picked', path: 'D:\\work\\bom' });
});

it('opens one window at a time: a second request while one is open is busy, and the first can be repeated afterwards', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const pick = picker(async () => { await gate; return { code: 0, stdout: 'D:\\a\r\n' }; });
  const first = pick();
  expect(await pick()).toEqual({ status: 'busy' });
  release();
  expect(await first).toEqual({ status: 'picked', path: 'D:\\a' });
  expect(await pick()).toEqual({ status: 'picked', path: 'D:\\a' });
});

it('POST /api/pick-folder needs the token and returns what the picker says; busy is 409', async () => {
  const answers: unknown[] = [{ status: 'picked', path: 'D:\\work\\x' }, { status: 'cancelled' }, { status: 'busy' }];
  const s = await bootServer({ pickFolder: async () => answers.shift() });
  expect((await req(s, '/api/pick-folder', { method: 'POST' })).status).toBe(401);
  expect((await ui(s, '/api/pick-folder', 'POST', {})).body).toEqual({ status: 'picked', path: 'D:\\work\\x' });
  expect((await ui(s, '/api/pick-folder', 'POST', {})).body).toEqual({ status: 'cancelled' });
  const busy = await ui(s, '/api/pick-folder', 'POST', {});
  expect(busy.status).toBe(409);
  expect(busy.body.code).toBe('folder.pickBusy');
});

it('works with no plan open (the welcome screen has no plan)', async () => {
  const s = await bootServer({ noPlan: true, pickFolder: async () => ({ status: 'picked', path: 'D:\\work\\y' }) });
  expect((await ui(s, '/api/pick-folder', 'POST', {})).body).toEqual({ status: 'picked', path: 'D:\\work\\y' });
});
