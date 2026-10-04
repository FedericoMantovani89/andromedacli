import { it, expect } from 'vitest';
import { buildClaudeLaunch } from '../src/server/pty/claude-launch';

const base = {
  command: ['claude'], role: 'main' as const, slug: 'shop-api', plan: 'shop-api',
  url: 'http://127.0.0.1:7391', token: 'T', bypass: false,
  baseEnv: { PATH: 'p', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'x', KEEP: 'y' },
};

it('sets the console variables and keeps unrelated ones', () => {
  const { env } = buildClaudeLaunch(base);
  expect(env).toMatchObject({
    CONSOLE_URL: 'http://127.0.0.1:7391', CONSOLE_TOKEN: 'T', CONSOLE_ROLE: 'main', CONSOLE_AGENT: 'shop-api', KEEP: 'y',
  });
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
