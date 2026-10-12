import { afterEach, expect, it } from 'vitest';
import { PtyManager } from '../src/server/pty/pty-manager';

const ptys = new PtyManager();
afterEach(async () => { await ptys.killAll(); });

it('killTree resolves only once the process has exited (B4)', async () => {
  ptys.spawn({ id: 'sleeper', file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: process.cwd(), env: { ...process.env } as Record<string, string>, cols: 80, rows: 24 });
  expect(ptys.status('sleeper')).toBe('running');
  await ptys.killTree('sleeper');
  expect(ptys.status('sleeper')).not.toBe('running');
});

it('killTree of an unknown id resolves at once', async () => {
  await expect(ptys.killTree('nobody')).resolves.toBeUndefined();
});
