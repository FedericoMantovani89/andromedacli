import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Every `.ts` file under `dir`, recursively (none when the folder is missing). */
export function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}
