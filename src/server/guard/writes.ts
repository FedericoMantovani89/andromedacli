import { tmpdir } from 'node:os';
import { isInside } from './paths';
import { commandName } from './shell';

const NULL_TARGET = /^(\/dev\/null|nul|\$null|&\d+)$/i;
const isFlag = (t: string): boolean => /^-/.test(t);
const PATH_PARAMS = /^-(path|filepath|literalpath|destination)$/i;
const VALUE_PARAMS = /^-(value|encoding|itemtype|stream|inputobject)$/i;
/** xcopy and robocopy switches (`/E`, `/MIR`): not paths. A POSIX path has a second slash, so `/c/Users` is not one. */
const SWITCH = /^\/[A-Za-z?][A-Za-z0-9:,.-]*$/;

/** Commands that write, move or delete every non-flag word they are given. */
const ALL = new Set([
  'tee', 'touch', 'mkdir', 'md', 'ln', 'mklink',
  'rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri', 'unlink',
  'mv', 'move', 'move-item', 'mi',
]);
/** Commands whose first word is the file written; the words after it are values (`Set-Content f.txt text`). */
const FIRST = new Set([
  'set-content', 'sc', 'add-content', 'ac', 'out-file', 'clear-content', 'clc', 'new-item', 'ni', 'rename-item', 'ren', 'rni',
]);
/** Copy commands: only the last word, the destination, is written. */
const LAST = new Set(['cp', 'copy', 'copy-item', 'cpi']);
/** `xcopy src dst`, `robocopy src dst`: the second word. */
const SECOND = new Set(['xcopy', 'robocopy']);

/** Where a command's output is redirected to (`> f`, `>>f`, `2>f`); `2>&1` is not one. */
export function redirectTargets(argv: string[]): string[] {
  const out: string[] = [];
  const rest = argv.slice(1);
  rest.forEach((t, i) => {
    if (/^\d*>>?$/.test(t) && rest[i + 1] !== undefined) out.push(rest[i + 1]!);
    else if (/^\d*>>?[^&>]/.test(t)) out.push(t.replace(/^\d*>>?/, ''));
  });
  return out;
}

/** Every word the command writes, moves or deletes: redirect targets, named paths (`-Path`, `-Destination`) and the words its kind of command writes. */
export function writeTargets(argv: string[]): string[] {
  const name = commandName(argv[0] ?? '');
  const rest = argv.slice(1);
  const out = redirectTargets(argv);
  const words: string[] = [];
  let named = false;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!;
    if (/^\d*>>?$/.test(t)) { i++; continue; } // a redirect operator and its target (already collected)
    if (/^\d*>>?[^&>]/.test(t) || /^\d*>&/.test(t)) continue;
    if (VALUE_PARAMS.test(t)) { i++; continue; }
    if (PATH_PARAMS.test(t)) { if (rest[i + 1] !== undefined) { out.push(rest[i + 1]!); named = true; } i++; continue; }
    if (isFlag(t)) continue;
    if (/^\/[A-Za-z?]$/.test(t) || (SECOND.has(name) && SWITCH.test(t))) continue; // `rd /s /q`, `del /q`: cmd switches, not paths
    words.push(t);
  }
  if (ALL.has(name)) out.push(...words);
  else if (!named && FIRST.has(name) && words[0] !== undefined) out.push(words[0]);
  else if (!named && LAST.has(name) && words.length > 0) out.push(words[words.length - 1]!);
  else if (!named && SECOND.has(name) && words[1] !== undefined) out.push(words[1]);
  return out;
}

export const isNullDevice = (target: string): boolean => NULL_TARGET.test(target.replace(/^["']|["']$/g, ''));

/** The first target outside the worktree. The null devices and the system temp folder are the two allowed places outside it. */
export function firstOutside(targets: string[], worktree: string, cwd: string): string | undefined {
  return targets.find((t) => !isNullDevice(t) && !isInside(worktree, t, cwd) && !isInside(tmpdir(), t, cwd));
}
