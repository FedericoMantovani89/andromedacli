// PreToolUse hook of Claude Code (see .claude/settings.json): refuses `git commit` until the FULL test suite has run green since the last
// change to the code. `npm test` leaves the stamp (scripts/stamp-tests.ts). A commit whose message starts with `wip:` skips the gate.
// Runs with plain `node` (type stripping): only erasable TypeScript syntax here, and nothing heavy to import.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const STAMP_DIR = join('node_modules', '.cache');
export const STAMP_FILE = join(STAMP_DIR, 'full-suite-ok.json');
export const BEGIN_FILE = join(STAMP_DIR, 'full-suite-begin.json');

/** `git commit`, also with options before the verb (`git -c user.name=x commit`, `git -C dir commit`). */
const COMMIT = /\bgit\s+(?:(?:-c|-C)\s+\S+\s+|--?[A-Za-z][\w-]*(?:=\S+)?\s+)*commit\b/;
/** The message starts with `wip:` (or `wip(scope):`), given by -m, --message or a heredoc. */
const WIP = /\bcommit\b[\s\S]*?(?:-m|--message|<<-?\s*'?\w+'?)[=\s]*["']?\s*(?:\n\s*)?wip[:(]/i;

/** What the shell would run: quoted text and heredoc bodies cannot hold the verb (`echo "git commit"`, a note that mentions it). */
const stripQuoted = (command: string): string =>
  command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2\b/g, '<<$2')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');

export const isCommit = (command: string): boolean => COMMIT.test(stripQuoted(command));
export const isWip = (command: string): boolean => WIP.test(command);

/** Documentation and notes do not make a green run stale. */
export const countsAsCode = (file: string): boolean => !/\.md$/i.test(file) && !file.startsWith('docs/');

export interface Verdict { block: boolean; message?: string }

/** `newest`: the most recent change to a code file as a time (ms), with the file; `stampMs`: when the last full green run began. */
export function verdict(command: string, newest: { ms: number; file: string } | undefined, stampMs: number): Verdict {
  if (!isCommit(command) || isWip(command)) return { block: false };
  if (!newest) return { block: false }; // nothing changed: nothing to prove
  if (stampMs >= newest.ms) return { block: false };
  const since = stampMs > 0 ? `since the last change to ${newest.file}` : 'at all (no green run on record)';
  return { block: true, message: `test-before-commit: the full test suite has not run green ${since}. Run \`npm test\` (about 10 minutes: as a background task, writing to a log), then commit. A commit whose message starts with "wip:" skips this gate.` };
}

/** The most recent change among the modified and the new files (documentation excluded). */
export function newestChange(cwd: string): { ms: number; file: string } | undefined {
  const git = (...args: string[]): string[] => {
    try { return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15_000 }).split('\n').map((l) => l.trim()).filter(Boolean); } catch { return []; }
  };
  const files = [...new Set([...git('diff', '--name-only', 'HEAD'), ...git('ls-files', '-o', '--exclude-standard')])].filter(countsAsCode);
  let best: { ms: number; file: string } | undefined;
  for (const file of files) {
    try {
      const ms = statSync(join(cwd, file)).mtimeMs;
      if (!best || ms > best.ms) best = { ms, file };
    } catch { /* a deleted file has no time */ }
  }
  return best;
}

export function readStamp(cwd: string): number {
  try { return Number((JSON.parse(readFileSync(join(cwd, STAMP_FILE), 'utf8')) as { at?: unknown }).at) || 0; } catch { return 0; }
}

/** `begin`: a full run starts now (its start, not its end, is what a later change must not precede); `done`: it passed. */
export function stamp(cwd: string, step: 'begin' | 'done'): void {
  mkdirSync(join(cwd, STAMP_DIR), { recursive: true });
  if (step === 'begin') { writeFileSync(join(cwd, BEGIN_FILE), JSON.stringify({ at: Date.now() })); return; }
  const begun = existsSync(join(cwd, BEGIN_FILE)) ? Number((JSON.parse(readFileSync(join(cwd, BEGIN_FILE), 'utf8')) as { at?: unknown }).at) || Date.now() : Date.now();
  writeFileSync(join(cwd, STAMP_FILE), JSON.stringify({ at: begun }));
}

async function readStdin(): Promise<string> {
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}

async function main(): Promise<void> {
  let input: { tool_input?: { command?: unknown }; cwd?: unknown } = {};
  try { input = JSON.parse(await readStdin()); } catch { process.exit(0); } // not a hook call we understand: never block
  const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
  if (!isCommit(command) || isWip(command)) process.exit(0);
  const cwd = process.env.CLAUDE_PROJECT_DIR ?? (typeof input.cwd === 'string' ? input.cwd : process.cwd());
  const v = verdict(command, newestChange(cwd), readStamp(cwd));
  if (v.block) { console.error(v.message); process.exit(2); }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
