import { it, expect } from 'vitest';
import { buildClaudeLaunch } from '../src/server/pty/claude-launch';

const base = {
  command: ['claude'], role: 'main' as const, slug: 'shop-api', project: 'shop-api',
  url: 'http://127.0.0.1:7391', token: 'T', bypass: false,
  baseEnv: { PATH: 'p', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'x', KEEP: 'y' },
};

it('sets the console variables and keeps unrelated ones', () => {
  const { env } = buildClaudeLaunch(base);
  expect(env).toMatchObject({
    CONSOLE_URL: 'http://127.0.0.1:7391', CONSOLE_TOKEN: 'T', CONSOLE_ROLE: 'main', CONSOLE_AGENT: 'shop-api', KEEP: 'y',
  });
});
it('sets NoDefaultCurrentDirectoryInExePath so cmd.exe does not run a claude.cmd that sits in the working folder', () => {
  expect(buildClaudeLaunch(base).env.NoDefaultCurrentDirectoryInExePath).toBe('1');
});
it('strips inherited Claude Code markers (they disable transcript saving)', () => {
  const { env } = buildClaudeLaunch(base);
  expect(env).not.toHaveProperty('CLAUDE_CODE_CHILD_SESSION');
  expect(env).not.toHaveProperty('CLAUDECODE');
  expect(env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
});
it('adds the bypass flag only when asked', () => {
  expect(buildClaudeLaunch(base).args).not.toContain('--dangerously-skip-permissions');
  expect(buildClaudeLaunch({ ...base, bypass: true }).args).toContain('--dangerously-skip-permissions');
});
it('uses the configured command', () => {
  const l = buildClaudeLaunch({ ...base, command: ['node', 'fake.cjs'], platform: 'linux' });
  expect(l.file).toBe('node');
  expect(l.args[0]).toBe('fake.cjs');
});
it('wraps the command in cmd.exe on Windows', () => {
  const l = buildClaudeLaunch({ ...base, platform: 'win32' });
  expect(l.file).toBe('cmd.exe');
  expect(l.args.slice(0, 2)).toEqual(['/c', 'claude']);
});

it('does not wrap an absolute .exe path in cmd.exe (spaces in "Program Files" break cmd quoting)', () => {
  const l = buildClaudeLaunch({ ...base, command: ['C:/Program Files/nodejs/node.exe', 'fake.cjs'], platform: 'win32' });
  expect(l.file).toBe('C:/Program Files/nodejs/node.exe');
  expect(l.args).toEqual(['fake.cjs']);
});

it('displayName adds --name, also together with --resume', () => {
  const l = buildClaudeLaunch({ ...base, displayName: 'demo AndromedaConsole', resumeId: 'abc-123', platform: 'linux' });
  expect(l.args.slice(l.args.indexOf('--name'), l.args.indexOf('--name') + 2)).toEqual(['--name', 'demo AndromedaConsole']);
  expect(l.args).toContain('--resume');
  expect(buildClaudeLaunch(base).args).not.toContain('--name');
});

it('resumeId adds --resume and the session id (also through cmd.exe on Windows)', () => {
  const l = buildClaudeLaunch({ ...base, resumeId: '3f2a9c1e-7b4d-4e2a-9f00-1234abcd5678', platform: 'linux' });
  const i = l.args.indexOf('--resume');
  expect(i).toBeGreaterThanOrEqual(0);
  expect(l.args[i + 1]).toBe('3f2a9c1e-7b4d-4e2a-9f00-1234abcd5678');
  const w = buildClaudeLaunch({ ...base, resumeId: 'abc-123', platform: 'win32' });
  expect(w.args.slice(w.args.indexOf('--resume'), w.args.indexOf('--resume') + 2)).toEqual(['--resume', 'abc-123']);
  expect(buildClaudeLaunch(base).args).not.toContain('--resume');
});
it('a session id with spaces, quotes or shell characters is rejected (it becomes a command-line argument)', () => {
  for (const bad of ['abc 123', 'abc"123', "abc'123", 'abc&calc', 'abc;rm', '', '--model', 'a/b']) {
    expect(() => buildClaudeLaunch({ ...base, resumeId: bad, platform: 'linux' }), bad).toThrow(/invalid session id/);
  }
});
