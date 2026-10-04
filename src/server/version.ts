import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_VERSION = '0.0.1';
const SAFE = /^[0-9A-Za-z.+_-]{1,40}$/;

const clean = (raw: string): string | undefined => {
  const v = raw.trim().replace(/^v/i, '');
  return SAFE.test(v) && /\d/.test(v) ? v : undefined;
};

function latestTag(dir: string, ref: string): string | undefined {
  try {
    return clean(execFileSync('git', ['describe', '--tags', '--abbrev=0', ref], { cwd: dir, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }));
  } catch {
    return undefined; // not a repository, no such branch, or no tag yet
  }
}

/**
 * The build version shown on the splash and in the tab title: the latest tag reachable from `main` (without the leading v),
 * else the one reachable from HEAD, else the version in package.json, else 0.0.1. A tag that is not plain characters is not trusted.
 */
export function resolveVersion(dir: string): string {
  const fromTag = latestTag(dir, 'main') ?? latestTag(dir, 'HEAD');
  if (fromTag) return fromTag;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof pkg.version === 'string' && clean(pkg.version)) return clean(pkg.version)!;
  } catch { /* no package.json */ }
  return DEFAULT_VERSION;
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Fills the `%VERSION%` placeholders of index.html (tab title and splash overlay). */
export function renderIndex(html: string, version: string): string {
  return html.split('%VERSION%').join(`v${escapeHtml(version)}`);
}
