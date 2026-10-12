import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { renderIndex, resolveVersion } from '../src/server/version';
import { removeDir } from './git-helpers';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) removeDir(dirs.pop()!); });

const g = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', ...a], { cwd, encoding: 'utf8' }).trim();
function repo(pkgVersion = '0.0.1'): string {
  const d = mkdtempSync(join(tmpdir(), 'ver-'));
  dirs.push(d);
  g(d, 'init', '-q', '-b', 'main');
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', version: pkgVersion }));
  g(d, 'add', '-A');
  g(d, 'commit', '-q', '-m', 'one');
  return d;
}
const commit = (d: string, msg: string): void => { g(d, 'commit', '-q', '--allow-empty', '-m', msg); };

it('falls back to the package.json version when there is no tag yet', () => {
  expect(resolveVersion(repo('0.0.1'))).toBe('0.0.1');
});
it('uses the latest tag reachable from main, without the leading v', () => {
  const d = repo();
  g(d, 'tag', 'v0.1.0');
  commit(d, 'two');
  g(d, 'tag', 'v0.2.3');
  commit(d, 'three');
  expect(resolveVersion(d)).toBe('0.2.3');
});
it('ignores a tag that is only on another branch', () => {
  const d = repo();
  g(d, 'tag', 'v0.1.0');
  g(d, 'checkout', '-q', '-b', 'feature');
  commit(d, 'feature work');
  g(d, 'tag', 'v9.9.9');
  g(d, 'checkout', '-q', 'main');
  expect(resolveVersion(d)).toBe('0.1.0');
});
it('accepts tags with or without the v', () => {
  const d = repo();
  g(d, 'tag', '1.4.0');
  expect(resolveVersion(d)).toBe('1.4.0');
});
it('a folder that is not a repository, or has no package.json, still gives a version', () => {
  const d = mkdtempSync(join(tmpdir(), 'ver-plain-'));
  dirs.push(d);
  expect(resolveVersion(d)).toBe('0.0.1');
  mkdirSync(join(d, 'sub'));
  expect(resolveVersion(join(d, 'sub'))).toBe('0.0.1');
});
it('a tag with odd characters is not trusted (it ends up in HTML)', () => {
  const d = repo();
  g(d, 'tag', 'v1.0.0&evil');
  expect(resolveVersion(d)).toBe('0.0.1');
});

it('renderIndex puts the version in the tab title and in the splash overlay, escaped', () => {
  const html = '<title>AndromedaConsole %VERSION%</title><div id="splash"><span id="splash-version">%VERSION%</span></div>';
  expect(renderIndex(html, '1.2.3')).toBe('<title>AndromedaConsole v1.2.3</title><div id="splash"><span id="splash-version">v1.2.3</span></div>');
  expect(renderIndex(html, '1.2.3<b>')).not.toContain('<b>');
});
