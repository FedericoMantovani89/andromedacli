import { afterEach, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { appRoot, resourcePath } from '../src/server/paths';

const saved = process.env.CONSOLE_APP_ROOT;
afterEach(() => { if (saved === undefined) delete process.env.CONSOLE_APP_ROOT; else process.env.CONSOLE_APP_ROOT = saved; });
const slashes = (p: string): string => p.split('\\').join('/');

it('defaults to the repository root, where the shipped folders are', () => {
  delete process.env.CONSOLE_APP_ROOT;
  for (const p of ['prompts', 'catalog', 'templates', 'mod', 'src/i18n', 'package.json']) expect(existsSync(resourcePath(p))).toBe(true);
});
it('CONSOLE_APP_ROOT replaces the root (the packaged app sets it)', () => {
  process.env.CONSOLE_APP_ROOT = 'C:/somewhere/app-root';
  expect(slashes(appRoot())).toBe('C:/somewhere/app-root');
  expect(slashes(resourcePath('prompts'))).toBe('C:/somewhere/app-root/prompts');
});
