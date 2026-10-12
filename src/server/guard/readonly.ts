import { commandName, QUOTED_MARK, type Segment } from './shell';

/** A session whose profile is `read_only` (a reviewer) may look at the code and run read-only commands; nothing else. */
export const READONLY_RULE = 'readonly.write';

const WRITERS = new Set([
  'cp', 'copy', 'copy-item', 'cpi', 'mv', 'move', 'move-item', 'mi', 'rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri', 'mkdir', 'md',
  'new-item', 'ni', 'touch', 'tee', 'set-content', 'sc', 'add-content', 'ac', 'out-file', 'clear-content', 'clc', 'rename-item', 'ren', 'rni',
  'ln', 'mklink', 'chmod', 'chown', 'truncate', 'dd', 'install', 'patch', 'wget', 'xcopy', 'robocopy', 'set-item', 'new-itemproperty', 'tee-object',
  'unzip', 'expand-archive', 'compress-archive', '7z', '7za', 'export-csv', 'export-clixml', 'export-alias', 'export-console', 'start-transcript',
]);
const GIT_READ = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'ls-files', 'grep', 'rev-parse', 'cat-file', 'ls-tree', 'shortlog', 'describe', 'merge-base',
  'for-each-ref', 'show-ref', 'diff-tree', 'rev-list', 'name-rev', 'whatchanged', 'reflog', 'count-objects', 'version', 'help',
  // listing forms only: the agent rules (rules.ts) refuse their changing forms
  'branch', 'tag', 'config', 'worktree', 'symbolic-ref', 'remote', 'stash',
]);
// Commands whose arguments are patterns and file names: a `>` inside an argument ("a>b", "=>") is text, not a redirection.
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'select-string', 'sls', 'findstr', 'git']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'pip', 'pip3', 'npx']);
const PACKAGE_CHANGES = new Set(['install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'update', 'upgrade', 'up', 'link', 'unlink', 'publish', 'init', 'dedupe', 'prune', 'rebuild']);
const NULL_TARGET = /^(\/dev\/null|nul|\$null|&\d|-)$/i;
const DOTNET_WRITE = /\[\s*(?:system\.)?io\.(?:file|directory|path|streamwriter)\s*\]\s*::\s*(?:write|append|create|delete|move|copy|open|replace|set)/i;

/** Where a command's output is redirected to (`> f`, `>>f`, `2>f`, `x>f`), leaving out null devices and `2>&1`. */
function redirectTargets(argv: string[], midToken: boolean): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t.endsWith(QUOTED_MARK)) continue; // a quoted ">" is text
    if (/\s/.test(t) && !/^(?:\d*|&)?>/.test(t)) continue; // quoted text, not an operator
    let target: string | undefined;
    if (/^(?:\d*|&)?>>?$/.test(t)) target = argv[i + 1];
    else {
      target = /^(?:\d*|&)?>>?(?!&)(.+)$/.exec(t)?.[1];
      if (target === undefined && midToken) target = /^[^>\s]+>>?(?!&)(.+)$/.exec(t)?.[1];
    }
    if (target !== undefined && !NULL_TARGET.test(target)) out.push(target);
  }
  return out;
}

/** The reason a read-only session may not run this command, or undefined when it may. */
export function readOnlyViolation(s: Segment): string | undefined {
  const name = commandName(s.argv[0] ?? '');
  const rest = s.argv.slice(1);
  if (redirectTargets(s.argv, !SEARCHERS.has(name)).length > 0) return 'redirecting output into a file changes it';
  if (WRITERS.has(name)) return `${name} changes files`;
  if (DOTNET_WRITE.test(s.raw)) return 'writing a file through .NET changes it';
  if (rest.some((a) => a === '--write' || a === '--fix' || a === '--in-place' || a.startsWith('--in-place='))) return 'this option writes files';
  if (name === 'node' && rest.some((a) => /^(-e|--eval|-p|--print)$/.test(a))) return 'node -e runs code that can write files';
  if (/^python3?$/.test(name) && rest.includes('-c')) return 'python -c runs code that can write files';
  if (name === 'sed' && rest.some((a) => a === '-i' || a.startsWith('-i'))) return 'sed -i edits files in place';
  if (name === 'awk' && (rest.includes('inplace') || rest.includes('--inplace'))) return 'awk in place edits files';
  if (name === 'perl' && rest.some((a) => /^-[a-zA-Z]*i[^a-zA-Z]*$/.test(a))) return 'perl -i edits files in place';
  if (name === 'find' && rest.some((a) => /^-(delete|fprint|fprintf|fls|exec|execdir|ok|okdir)$/.test(a))) return 'this find action changes files or runs commands';
  if (name === 'curl' && rest.some((a) => /^(-o|-O|-J|--output|--remote-name)/.test(a))) return 'curl would save a file';
  if (['iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod'].includes(name) && rest.some((a) => /^-out(file)?$/i.test(a))) return `${name} would save a file`;
  if (name === 'tar') {
    const mode = rest.find((a) => !a.startsWith('--') && /^-?[A-Za-z]+/.test(a)) ?? '';
    if (/[xcur]/.test(mode.replace(/^-/, '').replace(/[^A-Za-z].*$/, '')) && !/^--/.test(mode)) return 'tar would extract or create files';
  }
  if (PACKAGE_MANAGERS.has(name)) {
    const sub = rest.find((a) => !a.startsWith('-'));
    if ((sub !== undefined && PACKAGE_CHANGES.has(sub)) || (name === 'yarn' && sub === undefined)) return `${name} ${sub ?? ''} changes the installed packages`.trim();
  }
  if (name === 'git') {
    const parsed = gitParts(s.argv);
    if (parsed.configFlag) return 'git -c can change how git behaves';
    const sub = parsed.sub;
    if (sub !== undefined && !GIT_READ.has(sub)) return `git ${sub} changes the repository`;
    if (rest.some((a) => a === '--output' || a.startsWith('--output='))) return 'git --output writes a file';
    if (sub === 'remote') {
      const args = rest.filter((a) => !a.startsWith('-')).slice(1); // after the word "remote"
      if (args.length > 0 && args[0] !== 'show' && args[0] !== 'get-url') return 'git remote changes the repository';
    }
    if (sub === 'stash' && !['list', 'show'].includes(parsed.args[0] ?? '')) return 'git stash changes the repository';
    if (sub === 'reflog' && parsed.args.some((a) => a === 'expire' || a === 'delete')) return 'git reflog would delete history';
  }
  return undefined;
}

function gitParts(argv: string[]): { sub: string | undefined; args: string[]; configFlag: boolean } {
  let i = 1;
  let configFlag = false;
  while (i < argv.length) {
    const t = argv[i]!;
    if (t === '-c') { configFlag = true; i += 2; continue; }
    if (t === '-C' || t === '--git-dir' || t === '--work-tree' || t === '--namespace') { i += 2; continue; }
    if (t.startsWith('-')) { i++; continue; }
    return { sub: t.toLowerCase(), args: argv.slice(i + 1).filter((a) => !a.startsWith('-')), configFlag };
  }
  return { sub: undefined, args: [], configFlag };
}
