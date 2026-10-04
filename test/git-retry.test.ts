import { beforeEach, expect, it, vi } from 'vitest';

type Callback = (err: (Error & { code?: string | number }) | null, stdout: string, stderr: string) => void;
const calls: string[][] = [];
let script: ((attempt: number) => { err?: Error & { code?: string | number }; stdout?: string }) = () => ({ stdout: 'ok' });

vi.mock('node:child_process', () => ({
  execFile: (_file: string, args: string[], _opts: unknown, cb: Callback) => {
    calls.push(args);
    const r = script(calls.length);
    setImmediate(() => cb(r.err ?? null, r.stdout ?? '', ''));
  },
}));

const failing = (code: string | number): Error & { code?: string | number } => Object.assign(new Error(`failed with ${code}`), { code });

beforeEach(() => { calls.length = 0; });

it('retries a transient spawn failure (EAGAIN, EPERM, EBUSY, UNKNOWN) and then succeeds', async () => {
  const { git } = await import('../src/server/git/git');
  script = (n) => (n < 3 ? { err: failing('EAGAIN') } : { stdout: 'fine' });
  expect(await git('.', ['status'])).toEqual({ code: 0, stdout: 'fine', stderr: '' });
  expect(calls).toHaveLength(3);
});
it('gives up after a few tries and reports the failure', async () => {
  const { git } = await import('../src/server/git/git');
  script = () => ({ err: failing('EPERM') });
  const r = await git('.', ['status']);
  expect(r.code).not.toBe(0);
  expect(r.stderr).toContain('EPERM');
  expect(calls.length).toBe(4);
});
it('never retries a real git failure (a number exit code) or a missing git (ENOENT)', async () => {
  const { git } = await import('../src/server/git/git');
  script = () => ({ err: failing(1) });
  expect((await git('.', ['commit'])).code).toBe(1);
  expect(calls).toHaveLength(1);
  calls.length = 0;
  script = () => ({ err: failing('ENOENT') });
  expect((await git('.', ['status'])).code).not.toBe(0);
  expect(calls).toHaveLength(1);
});
