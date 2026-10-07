import { basename } from 'node:path';

export interface CliArgs {
  command: 'serve' | 'doctor';
  port: number;
  projectRoot: string;
  /** `--project-root` was given: only then does `serve` open that folder; otherwise it opens the remembered projects (or none). */
  projectRootGiven: boolean;
  noOpen: boolean;
  json: boolean;
}

export const DEFAULT_PORT = 7391;

export function parseCliArgs(argv: string[], cwd: string): CliArgs {
  const args: CliArgs = { command: 'serve', port: DEFAULT_PORT, projectRoot: cwd, projectRootGiven: false, noOpen: false, json: false };
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
    } else if (flag === '--project-root') {
      const v = rest[++i];
      if (!v) throw new Error('--project-root needs a folder');
      args.projectRoot = v;
      args.projectRootGiven = true;
    } else throw new Error(`unknown option "${flag}"`);
  }
  return args;
}

/** The project name doubles as the main session id and a slug: lowercase ASCII, dashes, at least 3 characters. */
export function projectNameFromDir(dir: string): string {
  const base = basename(dir)
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (base === '') return 'project';
  return base.length < 3 ? `project-${base}` : base.slice(0, 40).replace(/-+$/g, '');
}
