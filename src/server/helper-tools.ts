import type { PrereqResult } from '../shared/protocol';

/**
 * The optional command-line helpers (Options, Prerequisites): what each is for, in the words an agent reads, and the command names it
 * answers to. Installing a program does not make Claude use it, so the console tells every session which ones are really there.
 */
export const HELPERS = {
  rg: { purpose: 'searches file contents quickly', commands: ['rg'], instead: '`grep`' },
  fd: { purpose: 'finds files by name', commands: ['fd'], instead: '`find`' },
  jq: { purpose: 'reads and edits JSON', commands: ['jq'], instead: 'sed or ad-hoc scripts on JSON' },
  ctags: { purpose: 'builds an index of the symbols in a code base', commands: ['ctags'], instead: undefined },
  python: { purpose: 'runs scripts', commands: ['python', 'python3', 'py'], instead: undefined },
  uv: { purpose: 'manages Python packages and virtual environments', commands: ['uv'], instead: '`pip`' },
  shellcheck: { purpose: 'checks shell scripts', commands: ['shellcheck'], instead: undefined },
} as const satisfies Record<string, { purpose: string; commands: readonly string[]; instead: string | undefined }>;

export type HelperId = keyof typeof HELPERS;
export const HELPER_IDS = Object.keys(HELPERS) as HelperId[];

/** The helpers whose check answered with a version (an unknown or failed check is never listed: unknown is never "ok"). */
export function installedHelpers(prereq: PrereqResult[] | null): HelperId[] {
  if (!prereq) return [];
  return HELPER_IDS.filter((id) => prereq.some((r) => r.id === id && r.status === 'ok'));
}

/**
 * The paragraph added to the main's and every agent's system prompt: only the helpers that are installed now, each with what it is for,
 * and the habit to prefer them in the shell. Nothing when none is installed (and while the checks have not finished).
 */
export function helperToolsText(prereq: PrereqResult[] | null): string | undefined {
  const ids = installedHelpers(prereq);
  if (ids.length === 0) return undefined;
  const list = ids.map((id) => `\`${HELPERS[id].commands[0]}\` (${HELPERS[id].purpose})`).join(', ');
  const prefer = ids.flatMap((id) => (HELPERS[id].instead ? [`\`${HELPERS[id].commands[0]}\` over ${HELPERS[id].instead}`] : []));
  return [
    `Command-line helpers installed on this machine, available in the shell: ${list}.`,
    prefer.length > 0 ? `In shell commands prefer ${prefer.join(', ')}.` : undefined,
    'Use only the helpers listed here; do not assume any other tool exists.',
  ].filter((x): x is string => x !== undefined).join(' ');
}

/** The command words of a shell line: the first word of each pipeline stage or command (variables, `sudo`, `time` and a path skipped). */
export function commandWords(line: string): string[] {
  const words: string[] = [];
  for (const part of line.split(/\r?\n|&&|\|\||[|;&(){}`]|\$\(/)) {
    const tokens = part.trim().split(/\s+/).filter((t) => t !== '');
    let i = 0;
    while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!) || ['sudo', 'time', 'command', 'exec', 'env', 'nohup'].includes(tokens[i]!))) i++;
    const first = tokens[i];
    if (first === undefined) continue;
    const base = first.replace(/^["']|["']$/g, '').split(/[\\/]/).pop()!.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
    if (base !== '') words.push(base);
  }
  return words;
}

/** Which helpers a shell line uses, once each (a line that pipes into `jq` twice still counts one use). */
export function helpersUsedIn(line: string): HelperId[] {
  const words = new Set(commandWords(line));
  return HELPER_IDS.filter((id) => HELPERS[id].commands.some((c) => words.has(c)));
}
