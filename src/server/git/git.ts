import { execFile } from 'node:child_process';

export interface GitResult { code: number; stdout: string; stderr: string }

const MAX_SPAWN_ATTEMPTS = 4;
// Spawn failures that come from a busy machine (processes, handles, antivirus), not from git itself.
const TRANSIENT = new Set(['EAGAIN', 'EPERM', 'EBUSY', 'EMFILE', 'ENFILE', 'UNKNOWN', 'ENOMEM', 'DLL_INIT_FAILED']);
// Windows exit 0xC0000142 (STATUS_DLL_INIT_FAILED): the process died in the loader on a starved machine, before git ran anything, so a retry is safe.
const DLL_INIT_FAILED = 3221225794;

function run(cwd: string, args: string[], timeoutMs: number, extraEnv: Record<string, string>): Promise<GitResult & { spawnError?: string }> {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...extraEnv },
    }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      if (e.killed) return resolve({ code: -1, stdout: String(stdout), stderr: `${stderr}\ntimed out` });
      const spawnError = typeof e.code === 'string' ? e.code : e.code === DLL_INIT_FAILED ? 'DLL_INIT_FAILED' : undefined;
      resolve({ code: typeof e.code === 'number' ? e.code : 1, stdout: String(stdout), stderr: String(stderr || e.message), spawnError });
    });
  });
}

/**
 * Runs git without a shell. Never throws: a failure is an exit code and the stderr text. A spawn that fails because the machine is
 * busy (not because git said no) is retried a few times with a short pause; a real exit code is never retried.
 */
export async function git(cwd: string, args: string[], o: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<GitResult> {
  for (let attempt = 1; ; attempt++) {
    const { spawnError, ...result } = await run(cwd, args, o.timeoutMs ?? 60_000, o.env ?? {});
    if (!spawnError || !TRANSIENT.has(spawnError) || attempt >= MAX_SPAWN_ATTEMPTS) return result;
    await new Promise((r) => setTimeout(r, 100 * attempt));
  }
}
