import { afterEach, expect, it } from 'vitest';
import { PtyManager } from '../src/server/pty/pty-manager';
import { pipePty } from './pipe-pty';

const ptys = new PtyManager(pipePty);
afterEach(async () => { await ptys.killAll(); });
const env = { ...process.env } as Record<string, string>;
const until = async (f: () => boolean, ms = 8000): Promise<void> => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };
const start = (id: string, script: string): void => ptys.spawn({ id, file: process.execPath, args: ['-e', script], cwd: process.cwd(), env, cols: 80, rows: 24 });

it('PtyManager runs the process it is given through the injected spawn, and keeps its output', async () => {
  start('a', 'process.stdout.write("hello\\n")');
  await until(() => ptys.status('a') === 'exited');
  expect(ptys.snapshot('a').toString('utf8')).toContain('hello');
});

it('writes reach the process and its answer comes back', async () => {
  start('b', 'process.stdin.on("data", (d) => process.stdout.write("echo:" + d))');
  ptys.write('b', 'ping\n');
  await until(() => ptys.snapshot('b').toString('utf8').includes('echo:ping'));
});

it('the exit code is reported once, after the output', async () => {
  const seen: Array<[string, number]> = [];
  ptys.onExit((id, code) => seen.push([id, code]));
  start('c', 'process.stdout.write("bye"); process.exit(3)');
  await until(() => ptys.status('c') === 'exited');
  expect(seen).toEqual([['c', 3]]);
  expect(ptys.snapshot('c').toString('utf8')).toContain('bye');
});

it('killTree stops a process that would run for ever', async () => {
  start('d', 'setInterval(() => {}, 1000)');
  expect(ptys.status('d')).toBe('running');
  await ptys.killTree('d');
  expect(ptys.status('d')).toBe('exited');
});

it('a command that does not exist ends the session instead of throwing', async () => {
  ptys.spawn({ id: 'e', file: 'no-such-command-xyz', args: [], cwd: process.cwd(), env, cols: 80, rows: 24 });
  await until(() => ptys.status('e') === 'exited');
});
