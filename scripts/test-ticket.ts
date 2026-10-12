// `npm run test:ticket`: the checks, then the tests related to the diff against the project branch (`project/<name>`) a ticket's
// worktree branched from. The branch is named by $TICKET_BASE, else it is the only local `project/*` branch; in a plain checkout (none, or
// several) the base is origin/main, like `test:changed`.
import { spawnSync } from 'node:child_process';

const git = (args: string[]): string => spawnSync('git', args, { encoding: 'utf8' }).stdout?.trim() ?? '';
const isAncestor = (b: string): boolean => spawnSync('git', ['merge-base', '--is-ancestor', b, 'HEAD']).status === 0; // a leftover project branch HEAD does not descend from is no base
const branches = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/project/']).split(/\r?\n/).filter((b) => b !== '' && isAncestor(b));
const base = process.env.TICKET_BASE || (branches.length === 1 ? branches[0] : 'origin/main');
console.log(`test:ticket: tests related to the diff against ${base}`);
const run = (cmd: string, args: string[]): number => spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' }).status ?? 1;
const checked = run('npm', ['run', 'check']);
process.exit(checked !== 0 ? checked : run('npx', ['vitest', 'run', '--changed', base!, '--passWithNoTests']));
