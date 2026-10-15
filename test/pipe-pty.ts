import { spawn } from 'node:child_process';
import type { PtyProcess } from '../src/server/pty/pty-manager';

interface Options { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }

/**
 * A stand-in for the pseudo terminal in tests that only need "a process the console started": plain pipes, no ConPTY. The tests that read the
 * terminal (its output as a screen, its size) keep the real one. Output of stdout and stderr arrives as `onData`; the exit is reported once
 * the pipes are closed, so no output is lost behind it.
 */
export function pipePty(file: string, args: string[], o: Options): PtyProcess {
  const child = spawn(file, args, { cwd: o.cwd, env: { ...o.env, COLUMNS: String(o.cols), LINES: String(o.rows) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const data: Array<(chunk: string) => void> = [];
  const exit: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  let ended = false;
  const feed = (b: Buffer): void => { const s = b.toString('utf8'); for (const cb of data) cb(s); };
  const finish = (exitCode: number): void => { if (ended) return; ended = true; for (const cb of exit) cb({ exitCode }); };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  child.stdin.on('error', () => { /* the process is gone: a late write is not an error */ });
  child.on('close', (code) => finish(code ?? 1));
  child.on('error', () => finish(1));
  return {
    pid: child.pid ?? 0,
    onData: (cb) => { data.push(cb); },
    onExit: (cb) => { exit.push(cb); },
    write: (d) => { if (!child.stdin.destroyed) child.stdin.write(d); },
    resize: () => { /* pipes have no size */ },
    kill: () => { try { child.kill(); } catch { /* already gone */ } },
  };
}
