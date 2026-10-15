import { execFile } from 'node:child_process';
import * as nodePty from 'node-pty';
import { ByteRing } from './ring-buffer';

export interface SpawnOptions {
  id: string; file: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number;
}
type Status = 'running' | 'exited' | 'unknown';
/** What the manager uses of a terminal process (`node-pty`'s `IPty` has all of it): a test may give it plain pipes instead. */
export interface PtyProcess {
  pid: number;
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}
export type PtySpawn = (file: string, args: string[], o: PtyOptions) => PtyProcess;
interface Entry {
  pty: PtyProcess; ring: ByteRing; subs: Set<(chunk: Buffer) => void>; exited: boolean; cols: number; rows: number;
}

const TASKKILL_TIMEOUT_MS = 10_000;
const EXIT_WAIT_MS = 5_000;
const SCROLLBACK_BYTES = 4 * 1024 * 1024;
/** What a session that has ended keeps: reviewers get a new name every round, so the ended ones add up over a day. */
const EXITED_SCROLLBACK_BYTES = 256 * 1024;

export type PtyOptions = { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> };

/**
 * On Windows the ConPTY that comes with node-pty (OpenConsole) instead of the one in the system: the old one (Windows 10) drops the
 * alternate-screen and mouse requests of an application, so Claude Code in fullscreen mode never got the mouse wheel. If the bundled
 * one cannot start, the system's is used as before.
 */
export function spawnPty(file: string, args: string[], o: PtyOptions, spawn: typeof nodePty.spawn = nodePty.spawn, platform: string = process.platform): nodePty.IPty {
  if (platform === 'win32') {
    try { return spawn(file, args, { ...o, useConptyDll: true }); } catch { /* the bundled ConPTY is missing or failed: use the system's */ }
  }
  return spawn(file, args, o);
}

/** Owns every terminal process. Browser tabs only subscribe; closing a tab never touches a process (SPEC 4.4). */
export class PtyManager {
  private readonly entries = new Map<string, Entry>();
  private readonly exitCallbacks: ((id: string, code: number) => void)[] = [];
  private readonly discardCallbacks: ((id: string) => void)[] = [];

  /** `spawnProcess` is the real terminal unless a test gives another (`StartOptions.ptySpawn`). */
  constructor(private readonly spawnProcess: PtySpawn = (file, args, o) => spawnPty(file, args, o)) {}

  /**
   * Starts a session. An id whose process has exited may be started again (a resumed session): its scrollback and the terminals
   * already watching it are kept, so an open panel shows the new process without reconnecting. A running id is refused.
   */
  spawn(o: SpawnOptions): void {
    const old = this.entries.get(o.id);
    if (old && !old.exited) throw new Error(`pty ${o.id} already exists`);
    const pty = this.spawnProcess(o.file, o.args, { name: 'xterm-256color', cols: o.cols, rows: o.rows, cwd: o.cwd, env: o.env });
    old?.ring.resize(SCROLLBACK_BYTES); // a resumed session has the full room again
    const entry: Entry = { pty, ring: old?.ring ?? new ByteRing(SCROLLBACK_BYTES), subs: old?.subs ?? new Set(), exited: false, cols: o.cols, rows: o.rows };
    this.entries.set(o.id, entry);
    pty.onData((data) => {
      const chunk = Buffer.from(data, 'utf8');
      entry.ring.append(chunk);
      for (const cb of entry.subs) cb(chunk);
    });
    pty.onExit(({ exitCode }) => {
      entry.exited = true;
      entry.ring.resize(EXITED_SCROLLBACK_BYTES); // an ended session keeps its last part to read, not 4 MB for the rest of the run
      // A late exit of a process whose id was started again (a resume) is not the new session's exit: it must not mark it
      // interrupted nor revoke its token.
      if (this.entries.get(o.id) !== entry) return;
      for (const cb of this.exitCallbacks) cb(o.id, exitCode);
    });
  }

  write(id: string, data: Buffer | string): void {
    const e = this.entries.get(id);
    if (e && !e.exited) e.pty.write(typeof data === 'string' ? data : data.toString('utf8'));
  }

  resize(id: string, cols: number, rows: number): void {
    const e = this.entries.get(id);
    if (!e || e.exited || cols < 1 || rows < 1) return;
    e.pty.resize(cols, rows);
    e.cols = cols;
    e.rows = rows;
  }

  /** Fire-and-forget stop; use killTree/killAll when the caller must wait for the processes to be gone. */
  kill(id: string): void {
    void this.killTree(id);
  }

  /**
   * Stops a session and everything it started. On Windows, closing the pseudo console alone can block the whole
   * Node process for a minute while a real CLI winds down (measured with Claude Code), so the tree is terminated
   * first with taskkill.
   */
  /** Stops a session and its whole process tree, and waits until the process is gone (or 5 s): its files are free to delete after that. */
  async killTree(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e || e.exited) return;
    await this.killEntry(e);
  }

  private async killEntry(e: Entry): Promise<void> {
    if (process.platform === 'win32') {
      await new Promise<void>((done) => {
        execFile('taskkill', ['/PID', String(e.pty.pid), '/T', '/F'], { windowsHide: true, timeout: TASKKILL_TIMEOUT_MS }, () => done());
      });
    }
    try { e.pty.kill(); } catch { /* already gone */ }
    const deadline = Date.now() + EXIT_WAIT_MS;
    while (!e.exited && Date.now() < deadline) await new Promise<void>((r) => setTimeout(r, 25));
  }

  snapshot(id: string): Buffer {
    return this.entries.get(id)?.ring.snapshot() ?? Buffer.alloc(0);
  }

  subscribe(id: string, cb: (chunk: Buffer) => void): () => void {
    const e = this.entries.get(id);
    if (!e) return () => {};
    e.subs.add(cb);
    return () => { e.subs.delete(cb); };
  }

  onExit(cb: (id: string, code: number) => void): void {
    this.exitCallbacks.push(cb);
  }

  /** Called when a session is discarded (its exit is not reported, see `discard`): what the console holds for it must go too. */
  onDiscard(cb: (id: string) => void): void {
    this.discardCallbacks.push(cb);
  }

  status(id: string): Status {
    const e = this.entries.get(id);
    return !e ? 'unknown' : e.exited ? 'exited' : 'running';
  }

  size(id: string): { cols: number; rows: number } | undefined {
    const e = this.entries.get(id);
    return e ? { cols: e.cols, rows: e.rows } : undefined;
  }

  list(): string[] {
    return [...this.entries.keys()];
  }

  /** Stops a session and forgets it entirely (used when creating it failed half-way). */
  async discard(id: string): Promise<void> {
    const e = this.entries.get(id);
    this.entries.delete(id); // forgotten first: the exit of this process must not be reported as the session's
    for (const cb of this.discardCallbacks) { try { cb(id); } catch { /* cleanup never stops the discard */ } }
    if (e && !e.exited) await this.killEntry(e);
  }

  async killAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.killTree(id)));
  }
}
