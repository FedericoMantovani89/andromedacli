import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { win32 } from 'node:path';

/**
 * Turns a path as an agent writes it into a Windows path, or null when it cannot be verified (unknown variable, foreign POSIX
 * path). Handles `~`, `%VAR%`, `$env:VAR`, `$VAR`, `${VAR}` and the MSYS forms Git Bash prints (`/c/...`, `/tmp/...`).
 */
export function translatePath(input: string): string | null {
  let p = input.trim().replace(/^["']|["']$/g, '');
  if (p === '') return null;
  if (p === '~' || /^~[\\/]/.test(p)) p = homedir() + p.slice(1);
  let unresolved = false;
  const lookup = (name: string): string => {
    const v = process.env[name];
    if (v === undefined) unresolved = true;
    return v ?? '';
  };
  p = p
    .replace(/%([^%\\/]+)%/g, (_m, n: string) => lookup(n))
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_m, n: string) => lookup(n))
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, n: string) => lookup(n))
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, n: string) => lookup(n));
  if (unresolved) return null;
  if (/^\\\\\?\\[A-Za-z]:/.test(p)) p = p.slice(4);
  const msysDrive = /^\/([A-Za-z])(?:\/(.*))?$/.exec(p);
  if (msysDrive) return `${msysDrive[1]!.toUpperCase()}:\\${(msysDrive[2] ?? '').replace(/\//g, '\\')}`;
  if (p === '/tmp' || p.startsWith('/tmp/')) return win32.join(tmpdir(), p.slice(5));
  if (p.startsWith('/') && !p.startsWith('//')) return null;
  return p;
}

/** Resolves against `cwd`, then follows junctions and short names through the deepest part of the path that exists. */
export function realResolve(p: string, cwd: string): string | null {
  const t = translatePath(p);
  if (t === null) return null;
  const abs = win32.resolve(cwd, t);
  // A network path (\\server\share\...) is never inside a local folder, and checking whether it exists asks the network to resolve
  // the server name, which takes many seconds when the name is unknown: it stays as written, with no lookup. (A local path in the
  // extended form \\?\C:\... was already turned into C:\... above.)
  if (abs.startsWith('\\\\')) return abs;
  let existing = abs;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = win32.dirname(existing);
    if (parent === existing) return abs;
    rest.unshift(win32.basename(existing));
    existing = parent;
  }
  let real = existing;
  try { real = realpathSync.native(existing); } catch { /* keep the lexical path */ }
  return win32.join(real, ...rest);
}

const key = (p: string): string => win32.normalize(p).replace(/[\\/]+$/, '').toLowerCase();

/** True when `candidate` (relative to `cwd`) is `root` itself or below it. False when it cannot be verified. */
export function isInside(root: string, candidate: string, cwd: string): boolean {
  const r = realResolve(root, cwd);
  const c = realResolve(candidate, cwd);
  if (r === null || c === null) return false;
  const rk = key(r);
  const ck = key(c);
  return ck === rk || ck.startsWith(`${rk}\\`);
}

/** True when any component of the (lexical) path is `name`, case-insensitively. */
export function hasComponent(p: string, name: string): boolean {
  return p.split(/[\\/]+/).some((c) => c.toLowerCase() === name.toLowerCase());
}

/** Base name of a path written with either slash. */
export function baseName(p: string): string {
  const n = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return n.slice(n.lastIndexOf('/') + 1);
}
