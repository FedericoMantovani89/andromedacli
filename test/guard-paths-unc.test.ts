// A network (UNC) path can never be inside a local worktree, so the guard must decide without asking the network about it:
// `existsSync` on a UNC path resolves the server name, which takes many seconds when the name is unknown.
import { expect, it, vi } from 'vitest';
import { isInside, realResolve } from '../src/server/guard/paths';

vi.setConfig({ testTimeout: 60_000 });

const UNC = String.raw`\\server\share\x`;
const SLOW_MS = 1500;
const timed = <T>(f: () => T): { value: T; ms: number } => { const t = Date.now(); const value = f(); return { value, ms: Date.now() - t }; };

it.skipIf(process.platform !== 'win32')('resolves a UNC path without touching the network: lexical result, fast', () => {
  const r = timed(() => realResolve(UNC, String.raw`D:\work\repo`));
  expect(r.value).toBe(UNC);
  expect(r.ms).toBeLessThan(SLOW_MS);
});

it.skipIf(process.platform !== 'win32')('a UNC path is never inside a local folder, decided fast', () => {
  const r = timed(() => isInside(String.raw`D:\work\repo`, UNC, String.raw`D:\work\repo`));
  expect(r.value).toBe(false);
  expect(r.ms).toBeLessThan(SLOW_MS);
});

it.skipIf(process.platform !== 'win32')('a UNC root is only ever "inside" itself or below, without a lookup', () => {
  const r = timed(() => isInside(String.raw`\\server\share`, UNC, String.raw`D:\work\repo`));
  expect(r.value).toBe(true); // lexically below its own root
  expect(r.ms).toBeLessThan(SLOW_MS);
});

it.skipIf(process.platform !== 'win32')('a local extended-length path is still local: its drive prefix is read, not treated as a share', () => {
  const r = realResolve(String.raw`\\?\D:\work\repo\src\a.ts`, String.raw`D:\work\repo`);
  expect(r?.toLowerCase()).toBe(String.raw`d:\work\repo\src\a.ts`);
});
