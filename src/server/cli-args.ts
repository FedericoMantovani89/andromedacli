import { basename } from 'node:path';

export interface CliArgs {
  command: 'serve' | 'doctor';
  port: number;
  planRoot: string;
  noOpen: boolean;
  json: boolean;
}

export const DEFAULT_PORT = 7391;

export function parseCliArgs(argv: string[], cwd: string): CliArgs {
  const args: CliArgs = { command: 'serve', port: DEFAULT_PORT, planRoot: cwd, noOpen: false, json: false };
  const rest = [...argv];
  const first = rest[0];
  if (first && !first.startsWith('-')) {
    if (first !== 'serve' && first !== 'doctor') throw new Error(`unknown command "${first}" (use serve or doctor)`);
    args.command = first;
    rest.shift();
  }
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--no-open') args.noOpen = true;
    else if (flag === '--json') args.json = true;
    else if (flag === '--port') {
      const n = Number(rest[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('invalid --port (1-65535)');
      args.port = n;
    } else if (flag === '--plan-root') {
      const v = rest[++i];
      if (!v) throw new Error('--plan-root needs a folder');
      args.planRoot = v;
    } else throw new Error(`unknown option "${flag}"`);
  }
  return args;
}

/** The plan name doubles as the main session id and a slug: lowercase ASCII, dashes, at least 3 characters. */
export function planNameFromDir(dir: string): string {
  const base = basename(dir)
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (base === '') return 'plan';
  return base.length < 3 ? `plan-${base}` : base.slice(0, 40).replace(/-+$/g, '');
}
