import { execFile } from 'node:child_process';

export type CheckStatus = 'ok' | 'outdated' | 'missing' | 'error' | 'not_required';
export interface CheckResult {
  id: 'node' | 'git' | 'claude';
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

async function check(
  run: Runner, id: CheckResult['id'], cmd: string, args: string[], minimum?: string,
): Promise<CheckResult> {
  const base = { id, required: true } as const;
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
    if (code === 'ENOENT') return { ...base, status: 'missing' };
    return { ...base, status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** Read-only prerequisite checks (SPEC 29.3), all in parallel. The Claude check runs the command the console will really launch. */
export function runChecks(run: Runner = defaultRunner, o: { claudeCommand?: string[] } = {}): Promise<CheckResult[]> {
  const [claudeCmd, ...claudeArgs] = o.claudeCommand && o.claudeCommand.length > 0 ? o.claudeCommand : ['claude'];
  return Promise.all([
    check(run, 'node', 'node', ['--version'], MINIMUM.node),
    check(run, 'git', 'git', ['--version']),
    check(run, 'claude', claudeCmd!, [...claudeArgs, '--version'], MINIMUM.claude),
  ]);
}
