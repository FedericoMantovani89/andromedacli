import { execFile } from 'node:child_process';
import { win32 } from 'node:path';

/** What the native folder window gave back. Codes, never sentences: the UI translates them. */
export type PickFolderResult =
  | { status: 'picked'; path: string }
  | { status: 'cancelled' }
  | { status: 'unavailable'; reason: string }
  | { status: 'busy' };

export type PickRunner = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string }>;

/**
 * The window itself. The title is not part of the script: it travels in the environment (`CONSOLE_PICK_TITLE`), so no text can
 * ever turn into code. The hidden owner form is topmost so the window does not open behind the browser.
 */
export const PICK_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Windows.Forms',
  '[System.Windows.Forms.Application]::EnableVisualStyles()',
  '$owner = New-Object System.Windows.Forms.Form',
  '$owner.TopMost = $true',
  '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$dialog.Description = $env:CONSOLE_PICK_TITLE',
  '$dialog.ShowNewFolderButton = $true',
  'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
  '  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '  Write-Output $dialog.SelectedPath',
  '}',
  '$owner.Dispose()',
].join('\n');

const WAIT_LIMIT_MS = 10 * 60_000;

const defaultRun: PickRunner = (file, args, env) => new Promise((resolve, reject) => {
  execFile(file, args, { env: { ...process.env, ...env }, windowsHide: true, timeout: WAIT_LIMIT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
    if (!err) return resolve({ code: 0, stdout });
    const e = err as NodeJS.ErrnoException & { killed?: boolean };
    // Not started at all (or killed after the wait limit): the caller reports "unavailable". Any other failure is an exit code.
    if (e.code === 'ENOENT' || e.killed) return reject(err);
    resolve({ code: typeof e.code === 'number' ? e.code : 1, stdout });
  });
});

/**
 * The native "choose a folder" window (Windows only): the console runs on the user's own machine, so it can open one, which a
 * browser page cannot (it never learns an absolute path). One window at a time; a second request while one is open is `busy`.
 */
export function createFolderPicker(o: { title: () => string; platform?: NodeJS.Platform; run?: PickRunner }): () => Promise<PickFolderResult> {
  let open = false;
  return async () => {
    if ((o.platform ?? process.platform) !== 'win32') return { status: 'unavailable', reason: 'unsupported_platform' };
    if (open) return { status: 'busy' };
    open = true;
    try {
      const encoded = Buffer.from(PICK_SCRIPT, 'utf16le').toString('base64');
      let out: { code: number; stdout: string };
      try {
        out = await (o.run ?? defaultRun)('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], { CONSOLE_PICK_TITLE: o.title() });
      } catch {
        return { status: 'unavailable', reason: 'spawn_failed' };
      }
      if (out.code !== 0) return { status: 'unavailable', reason: 'failed' };
      const text = out.stdout.startsWith(String.fromCharCode(0xfeff)) ? out.stdout.slice(1) : out.stdout;
      const path = text.trim();
      // Closing the window prints nothing; anything that is not an absolute path is not a folder the user chose.
      return path !== '' && win32.isAbsolute(path) ? { status: 'picked', path } : { status: 'cancelled' };
    } finally {
      open = false;
    }
  };
}
