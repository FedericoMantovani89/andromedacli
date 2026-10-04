// Fails the build on user-visible literal strings in UI code and on .focus() outside src/ui/focus.ts (P2, P12).
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { findUiLiterals, findStrayFocus } from '../src/shared/i18n-checks';

const root = resolve(import.meta.dirname, '..');
const uiDir = join(root, 'src', 'ui');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

let failures = 0;
for (const file of walk(uiDir)) {
  const text = readFileSync(file, 'utf8');
  const rel = file.replace(root + sep, '');
  for (const f of findUiLiterals(text, file)) {
    console.error(`ui-literal: ${rel}:${f.line} literal visible text "${f.text}" (use t())`);
    failures++;
  }
  if (!file.endsWith(`${sep}focus.ts`)) {
    for (const line of findStrayFocus(text)) {
      console.error(`stray-focus: ${rel}:${line} .focus() outside src/ui/focus.ts (P2)`);
      failures++;
    }
  }
}
if (failures > 0) process.exit(1);
console.log('ui: no literal visible text, no stray focus()');
