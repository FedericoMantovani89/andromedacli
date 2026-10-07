import { execFile, spawn } from 'node:child_process';

export interface ValidationResult { ok: boolean; code: number | null; tail: string; timedOut?: boolean }

const TAIL_BYTES = 4096;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

/**
 * Runs the project's test command (the user wrote it, so it goes through the platform shell: `cmd` on Windows) in `cwd`, with a
 * timeout, and keeps the last 4 KiB of the combined output with colour codes removed. The console's own variables are not passed on.
 */
export function runValidation(o: { cwd: string; command: string; timeoutMs: number }): Promise<ValidationResult> {
  return new Promise((resolve) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CONSOLE_')));
    let out = '';
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null, extra = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = `${out}${extra}`.replace(ANSI, '').replace(/\r\n/g, '\n');
      resolve({ ok: code === 0 && !timedOut, code, tail: text.slice(-TAIL_BYTES), ...(timedOut ? { timedOut: true } : {}) });
    };
    const keep = (b: Buffer): void => { out = (out + b.toString('utf8')).slice(-4 * TAIL_BYTES); };

    let child;
    try {
      child = spawn(o.command, { cwd: o.cwd, shell: true, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (e) {
      return resolve({ ok: false, code: null, tail: e instanceof Error ? e.message : String(e) });
    }
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (e) => finish(null, `\n${e.message}`));
    child.on('close', (code) => finish(code));

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
      setTimeout(() => finish(null), 5000).unref(); // never wait forever for a process that will not die
    }, o.timeoutMs);
  });
}

function killTree(pid: number): void {
  if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  else {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}
