import { it, expect } from 'vitest';
import { join } from 'node:path';
import { PtyManager } from '../src/server/pty/pty-manager';

const fixture = join(__dirname, 'fixtures', 'fake-agent.cjs').replace(/\\/g, '/');
const spawnFake = (m: PtyManager, id: string) =>
  m.spawn({
    id, file: process.execPath, args: [fixture], cwd: process.cwd(),
    env: { ...process.env, CONSOLE_AGENT: id } as Record<string, string>, cols: 100, rows: 30,
  });
const until = async (f: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};

it('keeps the process and its scrollback when subscribers come and go', async () => {
  const m = new PtyManager();
  spawnFake(m, 'alpha-job');
  await until(() => m.snapshot('alpha-job').toString().includes('READY alpha-job'));
  const unsub = m.subscribe('alpha-job', () => {}); // a "tab" connects ...
  unsub(); // ... and closes
  m.write('alpha-job', 'hello\r');
  await until(() => m.snapshot('alpha-job').toString().includes('ECHO:hello'));
  expect(m.status('alpha-job')).toBe('running');
  m.kill('alpha-job');
});
// Node's own getWindowSize() is not refreshed in a ConPTY child, so ask a real console program instead.
it.skipIf(process.platform !== 'win32')('resizes the terminal', async () => {
  const m = new PtyManager();
  m.spawn({ id: 'beta-job', file: 'powershell.exe', args: ['-NoLogo', '-NoProfile'], cwd: process.cwd(), env: process.env as Record<string, string>, cols: 100, rows: 30 });
  // The first PowerShell of a cold runner takes seconds to show its prompt: a fixed pause lost the typed line there. Wait for the prompt.
  await until(() => m.snapshot('beta-job').toString().includes('PS '), 20_000);
  m.resize('beta-job', 80, 24);
  await new Promise((r) => setTimeout(r, 500));
  m.write('beta-job', 'Write-Output ("W=" + [Console]::WindowWidth + ";")\r');
  await until(() => m.snapshot('beta-job').toString().includes('W=80;'), 20_000);
  expect(m.size('beta-job')).toEqual({ cols: 80, rows: 24 });
  m.kill('beta-job');
}, 60_000);
it('reports exit', async () => {
  const m = new PtyManager();
  const exits: string[] = [];
  m.onExit((id) => exits.push(id));
  spawnFake(m, 'gamma-job');
  await until(() => m.snapshot('gamma-job').toString().includes('READY'));
  m.write('gamma-job', 'quit\r');
  await until(() => exits.includes('gamma-job'));
  expect(m.status('gamma-job')).toBe('exited');
});
it('delivers live output to subscribers', async () => {
  const m = new PtyManager();
  spawnFake(m, 'delta-job');
  await until(() => m.snapshot('delta-job').toString().includes('READY'));
  let got = '';
  m.subscribe('delta-job', (c) => { got += c.toString(); });
  m.write('delta-job', 'ping\r');
  await until(() => got.includes('ECHO:ping'));
  m.kill('delta-job');
});

it('killAll terminates the whole process tree, not just the direct child', async () => {
  const m = new PtyManager();
  const parent = join(__dirname, 'fixtures', 'fake-parent.cjs').replace(/\\/g, '/');
  m.spawn({ id: 'tree-job', file: process.execPath, args: [parent], cwd: process.cwd(), env: process.env as Record<string, string>, cols: 100, rows: 30 });
  await until(() => /CHILD \d+/.test(m.snapshot('tree-job').toString()));
  const pid = Number(/CHILD (\d+)/.exec(m.snapshot('tree-job').toString())![1]);
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  expect(alive()).toBe(true);
  await m.killAll();
  await until(() => !alive(), 5000);
  expect(alive()).toBe(false);
});

it('a late exit of a discarded process does not report the new session started under the same id', async () => {
  const m = new PtyManager();
  const exits: string[] = [];
  m.onExit((id) => exits.push(id));
  spawnFake(m, 'gamma-job');
  await until(() => m.snapshot('gamma-job').toString().includes('READY gamma-job'));
  await m.discard('gamma-job'); // the old process is being killed; its exit arrives later
  spawnFake(m, 'gamma-job');
  await new Promise((r) => setTimeout(r, 1500));
  expect(exits).toEqual([]);
  expect(m.status('gamma-job')).toBe('running');
  await m.killTree('gamma-job');
  await until(() => exits.length === 1);
  expect(exits).toEqual(['gamma-job']);
});
