import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PtyManager } from '../pty/pty-manager';
import type { PrereqResult } from '../../shared/protocol';
import { defaultRunner, type Runner } from './checks';

/**
 * Assisted installation of prerequisites (SPEC 29.3, 29.4). The console runs a FIXED command, shown to the user first, in a visible
 * terminal and only after a click. Nothing here is built from request data: the request names a tool, the table names the command.
 */
export interface InstallEntry {
  id: PrereqResult['id'];
  action: 'install' | 'update';
  /** Program first. Fixed arrays, never assembled from input. */
  argv: string[];
  /** The command as shown to the user: exactly the argv joined by spaces. */
  display: string;
  source: { kind: 'winget' | 'npm' | 'script'; origin: string };
  /** A vendor script: the user must confirm a second time. */
  secondConfirm: boolean;
  mayNeedAdmin: boolean;
  /** Run once on this machine (V23). False for every shipped entry: the dialog and the log say so. */
  verified: boolean;
}

const entry = (
  id: InstallEntry['id'], action: InstallEntry['action'], argv: string[], source: InstallEntry['source'], mayNeedAdmin: boolean,
): InstallEntry => ({ id, action, argv, display: argv.join(' '), source, secondConfirm: source.kind === 'script', mayNeedAdmin, verified: false });

const WINGET = { kind: 'winget', origin: 'winget (Microsoft)' } as const;
const NPM = { kind: 'npm', origin: 'npm (@anthropic-ai/claude-code)' } as const;

/** What the console can install or update. A vendor "download and run" script fits the shape (`kind: 'script'`); none ships yet. */
export const INSTALL_TABLE: readonly InstallEntry[] = [
  entry('node', 'install', ['winget', 'install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--source', 'winget'], WINGET, true),
  entry('node', 'update', ['winget', 'upgrade', '--id', 'OpenJS.NodeJS.LTS', '-e', '--source', 'winget'], WINGET, true),
  entry('git', 'install', ['winget', 'install', '--id', 'Git.Git', '-e', '--source', 'winget'], WINGET, true),
  entry('git', 'update', ['winget', 'upgrade', '--id', 'Git.Git', '-e', '--source', 'winget'], WINGET, true),
  entry('claude', 'install', ['npm', 'install', '-g', '@anthropic-ai/claude-code'], NPM, false),
  entry('claude', 'update', ['npm', 'install', '-g', '@anthropic-ai/claude-code@latest'], NPM, false),
  entry('gh', 'install', ['winget', 'install', '--id', 'GitHub.cli', '-e', '--source', 'winget'], WINGET, true),
  entry('gh', 'update', ['winget', 'upgrade', '--id', 'GitHub.cli', '-e', '--source', 'winget'], WINGET, true),
];

export type InstallUnavailable = 'unsupported_platform' | 'no_winget' | 'no_npm';
export interface InstallInfo {
  id: string; action: InstallEntry['action']; display: string; source: InstallEntry['source'];
  secondConfirm: boolean; mayNeedAdmin: boolean; verified: boolean;
}
/** What the state shows after an install ended; cleared on the next start of the console. */
export interface InstallOutcome { id: string; result: 'needs_admin' | 'failed' | 'done'; exitCode: number }

export type DescribeResult = { ok: true; info: InstallInfo } | { ok: false; code: 'not_found' } | { ok: false; code: 'unavailable'; unavailable: InstallUnavailable };
export type StartResult =
  | { ok: true; terminal: string }
  | { ok: false; httpStatus: number; code: string; params?: Record<string, string | number> };

export interface InstallServiceOptions {
  table?: readonly InstallEntry[];
  /** Console-wide manager that owns the utility terminals (never a project's agents). */
  ptys: PtyManager;
  /** Where the console's own files are: the install runs from there. */
  cwd: string;
  logPath: string;
  prereq: () => Promise<PrereqResult[]>;
  /** Runs the checks again (after an install ended) and broadcasts. */
  refresh: () => Promise<unknown>;
  changed: () => void;
  /** Probes `winget`/`npm` (injectable; default: the checks' runner). */
  run?: Runner;
  platform?: NodeJS.Platform;
  now?: () => Date;
}

const PROBE_TIMEOUT_MS = 5000;
const NEEDS_ADMIN_EXIT = 740;
/** Names that are shims on Windows: they only run through cmd.exe (same rule as the checks' runner). */
const SHIMS = new Set(['winget', 'npm']);
const terminalId = (id: string): string => `install-${id}`;

export class InstallService {
  private readonly table: readonly InstallEntry[];
  private readonly platform: NodeJS.Platform;
  private readonly run: Runner;
  private running: { id: string; entry: InstallEntry } | undefined;
  private outcome: InstallOutcome | undefined;

  constructor(private readonly o: InstallServiceOptions) {
    this.table = o.table ?? INSTALL_TABLE;
    this.platform = o.platform ?? process.platform;
    this.run = o.run ?? defaultRunner;
    o.ptys.onExit((tid, code) => { void this.onExit(tid, code); });
  }

  /** The last install result, or undefined (also while one runs). */
  state(): InstallOutcome | undefined {
    return this.outcome;
  }

  /** What the consent dialog shows for a tool, or why it cannot be installed from here. */
  async describe(id: string): Promise<DescribeResult> {
    const picked = await this.pick(id);
    if (!picked.ok) return picked;
    return { ok: true, info: this.infoOf(picked.entry) };
  }

  /** Starts the install after the user's consent. Every refusal carries a code, never a sentence. */
  async start(id: string, body: { confirmed?: unknown; confirmedScript?: unknown }): Promise<StartResult> {
    if (body.confirmed !== true) return { ok: false, httpStatus: 400, code: 'bad_request' };
    if (!this.table.some((e) => e.id === id)) return { ok: false, httpStatus: 404, code: 'not_found' };
    const candidate = this.table.find((e) => e.id === id && e.secondConfirm);
    if (candidate && body.confirmedScript !== true) return { ok: false, httpStatus: 400, code: 'bad_request' };
    if (this.running) return { ok: false, httpStatus: 409, code: 'install.busy' };
    const picked = await this.pick(id);
    if (!picked.ok) {
      return picked.code === 'not_found'
        ? { ok: false, httpStatus: 404, code: 'not_found' }
        : { ok: false, httpStatus: 422, code: 'install.unavailable', params: { reason: picked.unavailable } };
    }
    if (this.running) return { ok: false, httpStatus: 409, code: 'install.busy' }; // another request got in while probing
    const e = picked.entry;
    if (e.secondConfirm && body.confirmedScript !== true) return { ok: false, httpStatus: 400, code: 'bad_request' };
    const [program, ...args] = e.argv as [string, ...string[]];
    const viaCmd = this.platform === 'win32' && SHIMS.has(program);
    // No console variables (CONSOLE_URL/TOKEN...): the installer is nobody's agent.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith('CONSOLE_'))) as Record<string, string>;
    const tid = terminalId(id);
    this.running = { id, entry: e };
    this.outcome = undefined;
    try {
      this.o.ptys.spawn({ id: tid, file: viaCmd ? 'cmd.exe' : program, args: viaCmd ? ['/c', program, ...args] : args, cwd: this.o.cwd, env, cols: 100, rows: 24 });
    } catch {
      this.running = undefined;
      return { ok: false, httpStatus: 422, code: 'install.unavailable', params: { reason: 'spawn_failed' } };
    }
    return { ok: true, terminal: tid };
  }

  private infoOf(e: InstallEntry): InstallInfo {
    return { id: e.id, action: e.action, display: e.display, source: e.source, secondConfirm: e.secondConfirm, mayNeedAdmin: e.mayNeedAdmin, verified: e.verified };
  }

  /** Finds the entry for a tool that needs one, and checks the platform and the program that would run it. */
  private async pick(id: string): Promise<{ ok: true; entry: InstallEntry } | { ok: false; code: 'not_found' } | { ok: false; code: 'unavailable'; unavailable: InstallUnavailable }> {
    if (!this.table.some((e) => e.id === id)) return { ok: false, code: 'not_found' };
    if (this.platform !== 'win32') return { ok: false, code: 'unavailable', unavailable: 'unsupported_platform' };
    const status = (await this.o.prereq()).find((c) => c.id === id)?.status;
    if (status !== 'missing' && status !== 'outdated' && status !== 'error') return { ok: false, code: 'not_found' };
    const wanted: InstallEntry['action'] = status === 'missing' ? 'install' : 'update';
    const e = this.table.find((x) => x.id === id && x.action === wanted) ?? this.table.find((x) => x.id === id)!;
    if (e.source.kind !== 'script') {
      try {
        const r = await this.run(e.argv[0]!, ['--version'], PROBE_TIMEOUT_MS);
        if (r.code !== 0) return { ok: false, code: 'unavailable', unavailable: e.source.kind === 'npm' ? 'no_npm' : 'no_winget' };
      } catch {
        return { ok: false, code: 'unavailable', unavailable: e.source.kind === 'npm' ? 'no_npm' : 'no_winget' };
      }
    }
    return { ok: true, entry: e };
  }

  private async onExit(tid: string, code: number): Promise<void> {
    const running = this.running;
    if (!running || terminalId(running.id) !== tid) return;
    const tail = this.o.ptys.snapshot(tid).toString('utf8').slice(-4000);
    const result: InstallOutcome['result'] = code === 0 ? 'done' : code === NEEDS_ADMIN_EXIT || /administrator|elevat/i.test(tail) ? 'needs_admin' : 'failed';
    try {
      mkdirSync(dirname(this.o.logPath), { recursive: true });
      appendFileSync(this.o.logPath, `${JSON.stringify({ at: (this.o.now?.() ?? new Date()).toISOString(), id: running.id, action: running.entry.action, display: running.entry.display, exitCode: code, verified: running.entry.verified })}\n`);
    } catch { /* the log is a record, not a requirement */ }
    try { await this.o.refresh(); } catch { /* the table shows the old result; the user can check again */ }
    this.outcome = { id: running.id, result, exitCode: code };
    this.running = undefined;
    this.o.changed();
  }
}
