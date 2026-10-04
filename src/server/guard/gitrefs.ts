import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The branch a repository's HEAD points at (`main`), or undefined when detached or unreadable. Only a regular `.git` folder is read. */
export function headBranch(repo: string): string | undefined {
  try {
    const text = readFileSync(join(repo, '.git', 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

/** True when `name` (or `refs/tags/<name>`) is an existing tag of the repository: a loose ref or a line of packed-refs. */
export function isTag(repo: string, name: string): boolean {
  const tag = name.replace(/^refs\/tags\//, '');
  if (tag === '' || /[\s:*?[\\^~]/.test(tag) || tag.includes('..')) return false;
  try {
    if (existsSync(join(repo, '.git', 'refs', 'tags', ...tag.split('/')))) return true;
    const packed = join(repo, '.git', 'packed-refs');
    return existsSync(packed) && readFileSync(packed, 'utf8').split(/\r?\n/).some((l) => l.endsWith(` refs/tags/${tag}`));
  } catch {
    return false;
  }
}
