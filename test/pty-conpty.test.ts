import { expect, it, vi } from 'vitest';
import type * as nodePty from 'node-pty';
import { spawnPty } from '../src/server/pty/pty-manager';

const base = { name: 'xterm-256color', cols: 120, rows: 30, cwd: '.', env: {} };
const fake = (impl: (o: Record<string, unknown>) => unknown) => vi.fn((_f: string, _a: string[], o: Record<string, unknown>) => impl(o)) as unknown as typeof nodePty.spawn & ReturnType<typeof vi.fn>;

it('on Windows it asks for the ConPTY bundled with node-pty', () => {
  const spawn = fake(() => ({ pid: 1 }));
  spawnPty('claude', [], base, spawn, 'win32');
  expect((spawn as any).mock.calls).toHaveLength(1);
  expect((spawn as any).mock.calls[0][2]).toMatchObject({ useConptyDll: true, cols: 120 });
});
it('on Windows, if the bundled ConPTY cannot start, it falls back to the system one', () => {
  const spawn = fake((o) => { if (o.useConptyDll) throw new Error('no dll'); return { pid: 2 }; });
  expect(spawnPty('claude', [], base, spawn, 'win32')).toEqual({ pid: 2 });
  expect((spawn as any).mock.calls.map((c: unknown[]) => 'useConptyDll' in (c[2] as object))).toEqual([true, false]);
});
it('elsewhere the option is not passed', () => {
  const spawn = fake(() => ({ pid: 3 }));
  spawnPty('claude', [], base, spawn, 'linux');
  expect((spawn as any).mock.calls[0][2]).not.toHaveProperty('useConptyDll');
});
