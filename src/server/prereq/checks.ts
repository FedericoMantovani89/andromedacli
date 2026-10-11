import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage } from '../../shared/guards';

/** `restart`: installed where the installer puts it, but this process does not see it (Windows gives a program the PATH it started with). */
export type CheckStatus = 'ok' | 'outdated' | 'missing' | 'error' | 'not_required' | 'restart';
export interface CheckResult {
  id: 'node' | 'git' | 'claude' | 'gh' | 'python' | 'rg' | 'ctags' | 'jq' | 'fd' | 'shellcheck' | 'uv';
  required: boolean;
  status: CheckStatus;
  version?: string;
  message?: string;
}
export type Runner = (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string }>;

/** Minimum versions (SPEC 29.3; Node minimum decided in Phase 1, SPEC 27.21). */
export const MINIMUM = { node: '22', claude: '2.1.287' } as const;
const CHECK_TIMEOUT_MS = 8000;

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const parseVersion = (text: string): string | undefined => /(\d+\.\d+(?:\.\d+)?)/.exec(text)?.[1];

function execOnce(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (!err) return resolve({ code: 0, stdout: String(stdout) });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
      if (e.killed) return reject(Object.assign(new Error(`timed out after ${timeoutMs} ms`), { code: 'ETIMEDOUT' }));
      if (e.code === 'ENOENT') return reject(e);
      resolve({ code: typeof e.code === 'number' ? e.code : 1, stdout: String(stdout) });
    });
  });
}

/** Runs a command; on Windows a tool installed as a .cmd shim (npm install of Claude Code) is retried through cmd.exe. */
export const defaultRunner: Runner = async (cmd, args, timeoutMs) => {
  try {
    return await execOnce(cmd, args, timeoutMs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || process.platform !== 'win32') throw e;
    const viaCmd = await execOnce('cmd.exe', ['/c', cmd, ...args], timeoutMs);
    if (viaCmd.code !== 0 && viaCmd.stdout.trim() === '') throw Object.assign(new Error(`${cmd} not found`), { code: 'ENOENT' });
    return viaCmd;
  }
};

/**
 * Where the shipped installers (winget) put a tool on Windows, a fixed list: used only to tell "not installed" from "installed, but this
 * console started before it was and cannot see it". Nothing is read from the registry or the environment of other programs.
 */
export function installLocations(id: CheckResult['id'], env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string[] {
  if (platform !== 'win32') return [];
  const programFiles = env.ProgramFiles ?? 'C:/Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)';
  const local = env.LOCALAPPDATA;
  const userPrograms = local ? [local] : [];
  switch (id) {
    case 'node': return [join(programFiles, 'nodejs', 'node.exe')];
    case 'git': return [join(programFiles, 'Git', 'cmd', 'git.exe'), join(programFilesX86, 'Git', 'cmd', 'git.exe'), ...userPrograms.map((l) => join(l, 'Programs', 'Git', 'cmd', 'git.exe'))];
    case 'gh': return [join(programFiles, 'GitHub CLI', 'gh.exe'), ...userPrograms.map((l) => join(l, 'Programs', 'GitHub CLI', 'gh.exe'))];
    default: return []; // claude, and the optional helpers: they are only ever asked for their version, no folder is looked into the command is the user's own (an npm shim, a custom path)
  }
}

async function check(
  run: Runner, id: CheckResult['id'], cmd: string, args: string[], minimum?: string, required = true,
  locate: (id: CheckResult['id']) => string[] = installLocations, exists: (p: string) => boolean = existsSync,
): Promise<CheckResult> {
  const base = { id, required } as const;
  try {
    const r = await run(cmd, args, CHECK_TIMEOUT_MS);
    if (r.code !== 0) return { ...base, status: 'error', message: `exit code ${r.code}` };
    const version = parseVersion(r.stdout);
    if (!version) return { ...base, status: 'error', message: 'could not read a version from the output' };
    if (minimum && compareVersions(version, minimum) < 0) {
      return { ...base, status: 'outdated', version, message: `needs >= ${minimum}` };
    }
    return { ...base, status: 'ok', version };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // Never a false "ok": a check that cannot produce a result says "error" with the reason (P7).
    if (code === 'ENOENT') {
      // Not on the PATH of this process. Run `--version` where the installer puts it: if it answers, it is installed and a restart shows it.
      for (const where of locate(id).filter(exists)) {
        try {
          const r = await run(where, args, CHECK_TIMEOUT_MS);
          const version = r.code === 0 ? parseVersion(r.stdout) : undefined;
          if (version) return { ...base, status: 'restart', version, message: where };
        } catch { /* not runnable there: keep looking */ }
      }
      return { ...base, status: 'missing' };
    }
    return { ...base, status: 'error', message: errorMessage(e) };
  }
}

/** For the optional helpers: no folder is ever looked into, the tool is only asked for its version. */
const NO_FOLDERS = (): string[] => [];

/** Read-only prerequisite checks (SPEC 29.3), all in parallel. The Claude check runs the command the console will really launch. */
export function runChecks(run: Runner = defaultRunner, o: { claudeCommand?: string[]; locate?: (id: CheckResult['id']) => string[]; exists?: (p: string) => boolean } = {}): Promise<CheckResult[]> {
  const [claudeCmd, ...claudeArgs] = o.claudeCommand && o.claudeCommand.length > 0 ? o.claudeCommand : ['claude'];
  // An injected runner (tests) never looks at the real disk for installer locations.
  const locate = o.locate ?? (run === defaultRunner ? installLocations : () => []);
  return Promise.all([
    check(run, 'node', 'node', ['--version'], MINIMUM.node, true, locate, o.exists),
    check(run, 'git', 'git', ['--version'], undefined, true, locate, o.exists),
    check(run, 'claude', claudeCmd!, [...claudeArgs, '--version'], MINIMUM.claude),
    // Optional (the GitHub CLI is only for pull requests): missing never blocks anything.
    check(run, 'gh', 'gh', ['--version'], undefined, false, locate, o.exists),
    // Optional helpers for the agents' own shell work (scripts, searching, JSON, linting): the console itself never needs them. Each is
    // judged only by running `<tool> --version`; the PATH and the disk are never scanned.
    check(run, 'python', 'python', ['--version'], undefined, false, NO_FOLDERS, o.exists),
    check(run, 'rg', 'rg', ['--version'], undefined, false, NO_FOLDERS, o.exists),
    check(run, 'ctags', 'ctags', ['--version'], undefined, false, NO_FOLDERS, o.exists),
    check(run, 'jq', 'jq', ['--version'], undefined, false, NO_FOLDERS, o.exists),
    check(run, 'fd', 'fd', ['--version'], undefined, false, NO_FOLDERS, o.exists),
    check(run, 'shellcheck', 'shellcheck', ['--version'], undefined, false, NO_FOLDERS, o.exists),
    check(run, 'uv', 'uv', ['--version'], undefined, false, NO_FOLDERS, o.exists),
  ]);
}
