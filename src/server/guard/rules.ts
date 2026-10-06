import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import { findSecrets } from '../git/secrets';
import { baseName, hasComponent, isInside, realResolve } from './paths';
import { headBranch, isTag } from './gitrefs';
import { commandName, splitCommand, type Segment, type ShellKind } from './shell';
import { READONLY_RULE, readOnlyViolation } from './readonly';

export interface GuardContext {
  role?: 'main' | 'agent';
  /** A read-only profile (a reviewer): nothing may be changed. */
  readOnly?: boolean;
  /** A session held back by the console. For `loop` only the call with this exact signature is refused; for the others every guarded tool is. */
  restricted?: { reason: 'budget' | 'loop' | 'limit'; signature?: string };
  worktree: string; repo: string; branch: string; planBranch: string; secretPatterns: string[] }
export interface GuardCall { role: 'main' | 'agent'; tool: string; input: Record<string, unknown> }
export type GuardDecision = { decision: 'allow' } | { decision: 'deny'; reason: string; rule: string };

const ALLOW: GuardDecision = { decision: 'allow' };
const deny = (rule: string, reason: string): GuardDecision => ({ decision: 'deny', rule, reason });

/** Rules that also bind the main session (SPEC 14.2). Everything else is for agents only. */
const MAIN_RULES = new Set(['git.force', 'git.delete-ref', 'git.tag', 'secret.file', 'rm.wide', 'net.download-exec', 'git.protected-ref', 'git.no-verify', 'git.hooks-tamper', 'agent.builtin-subagent']);

/** Claude Code's built-in subagent types that only look things up. Any other (general-purpose, or none given) can change files. */
const READONLY_SUBAGENTS = new Set(['explore', 'plan', 'claude-code-guide']);

const PROTECTED_REF = /^(main|master|develop|trunk|release\/.+)$/;
const TEMPLATE_SUFFIX = /\.(example|sample|template|dist)$/i;
const FILE_READERS = new Set([
  'cat', 'type', 'less', 'more', 'head', 'tail', 'cp', 'copy', 'mv', 'move', 'scp', 'get-content', 'gc', 'select-string', 'sls',
  'grep', 'egrep', 'fgrep', 'rg', 'base64', 'xxd', 'od', 'strings', 'sed', 'awk', 'tar', 'zip', '7z', 'compress-archive',
  'source', '.', 'copy-item', 'cpi', 'move-item', 'mi', 'xcopy', 'robocopy', 'bat', 'nl', 'tac', 'cut', 'sort', 'diff', 'cmp',
]);
const PATTERN_FIRST = new Set(['grep', 'egrep', 'fgrep', 'rg', 'select-string', 'sls', 'sed', 'awk']);
const WRITERS = new Set([
  'cp', 'copy', 'mv', 'move', 'rm', 'del', 'erase', 'tee', 'sed', 'set-content', 'sc', 'out-file', 'add-content', 'ac',
  'new-item', 'ni', 'remove-item', 'ri', 'copy-item', 'cpi', 'move-item', 'mi', 'touch', 'mkdir', 'rd', 'rmdir', 'ln', 'xcopy', 'echo',
]);
const RM_COMMANDS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'unlink']);
const DOWNLOADERS = new Set(['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod']);
const EXEC_SINKS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'iex', 'invoke-expression', 'powershell', 'pwsh', 'cmd', 'python', 'python3', 'node', 'perl', 'ruby']);
const EXEC_EXT = /\.(exe|bat|cmd|ps1|sh|msi|dll|com|scr|vbs|jar)$/i;
const DOWNLOAD_RAW = /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|downloadfile)\b/i;

const CD_COMMANDS = new Set(['cd', 'chdir', 'set-location', 'sl', 'pushd']);
const isFlag =(t: string): boolean => /^-/.test(t);

/** Subcommand and its arguments after git's global options; `-c` values and `--git-dir` are reported too. */
function parseGit(argv: string[]): { sub: string; args: string[]; globalConfig: string[] } {
  const globalConfig: string[] = [];
  let i = 1;
  while (i < argv.length) {
    const t = argv[i]!;
    if (t === '-C' || t === '--git-dir' || t === '--work-tree' || t === '--namespace' || t === '--super-prefix') { i += 2; continue; }
    if (t === '-c') { if (argv[i + 1] !== undefined) globalConfig.push(argv[i + 1]!); i += 2; continue; }
    if (isFlag(t)) { i++; continue; }
    break;
  }
  return { sub: (argv[i] ?? '').toLowerCase(), args: argv.slice(i + 1), globalConfig };
}

const hasShort = (args: string[], letter: string): boolean => args.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(letter));

function gitRule(argv: string[], ctx: GuardContext): GuardDecision {
  const { sub, args, globalConfig } = parseGit(argv);
  const flags = args.filter((a) => isFlag(a));
  const positional = args.filter((a) => !isFlag(a));
  // The pre-push hook is what stops a push of main: neither a hooks path nor an alias (that could hide --no-verify) may be set.
  if (globalConfig.some((c) => /^(core\.hookspath|alias\.)/i.test(c)) || argv.some((t) => /core\.hookspath/i.test(t)) || (sub === 'config' && argv.some((t) => /^alias\./i.test(t)))) {
    return deny(ctx.role === 'main' ? 'git.hooks-tamper' : 'git.config-write', 'changing core.hooksPath or an alias would get around the console push hook');
  }
  switch (sub) {
    case 'push': {
      const refspecs = positional.slice(1);
      if (flags.some((f) => f === '--force' || f.startsWith('--force-with-lease') || f === '--mirror') || hasShort(args.filter((a) => !a.startsWith('--')), 'f') || refspecs.some((r) => r.startsWith('+'))) {
        return deny('git.force', 'a force push is not allowed');
      }
      if (flags.includes('--delete') || hasShort(args.filter((a) => !a.startsWith('--')), 'd') || refspecs.some((r) => r.startsWith(':'))) {
        return deny('git.delete-ref', 'deleting a remote branch is not allowed');
      }
      if (flags.includes('--tags') || flags.includes('--follow-tags') || refspecs.some((r) => r.startsWith('refs/tags/') || isTag(ctx.repo, r))) {
        return deny('git.tag', 'pushing tags is not allowed');
      }
      // `git push`, `git push origin`, `git push origin HEAD` and `--all` all push the checked-out branch.
      const current = ctx.role === 'main' ? headBranch(ctx.repo) : ctx.branch;
      const target = refspecs.map((r) => r.split(':').pop()!.replace(/^refs\/heads\//, '')).map((r) => (r === 'HEAD' && current ? current : r));
      if ((refspecs.length === 0 || flags.includes('--all')) && current) target.push(current);
      const bad = target.find((r) => PROTECTED_REF.test(r));
      if (bad !== undefined) return deny('git.protected-ref', `pushing to ${bad} is not allowed`);
      // A wildcard refspec can name main or a tag without saying so: it cannot be checked, so it is refused.
      if (refspecs.some((r) => r.includes('*'))) return deny('git.protected-ref', 'a wildcard refspec could push a protected branch or a tag');
      if (flags.includes('--no-verify')) return deny('git.no-verify', 'skipping the push hook is not allowed');
      return deny('git.commit-push', 'the console pushes the branch at the end of the ticket');
    }
    case 'send-pack': case 'http-push':
      return deny('git.protected-ref', `git ${sub} would push around the console push hook`);
    case 'commit':
      if (flags.includes('--no-verify') || hasShort(args.filter((a) => !a.startsWith('--')), 'n')) return deny('git.no-verify', 'skipping hooks is not allowed');
      return deny('git.commit-push', 'the console commits after each step: call step_done');
    case 'tag': {
      const readOnly = positional.length === 0 && flags.every((f) => /^(-l|--list|-n\d*|-v|--verify|--contains|--no-contains|--points-at|--sort.*|--format.*|--merged|--no-merged|--column|--no-column)$/.test(f));
      const listing = flags.some((f) => f === '-l' || f === '--list');
      return readOnly || listing ? ALLOW : deny('git.tag', 'creating or deleting tags is not allowed');
    }
    case 'branch': {
      if (flags.some((f) => f === '--delete' || f === '-D' || f === '-d') || hasShort(args.filter((a) => !a.startsWith('--')), 'd') || hasShort(args.filter((a) => !a.startsWith('--')), 'D')) {
        return deny('git.delete-ref', 'deleting a branch is not allowed');
      }
      if (flags.includes('--force') || hasShort(args.filter((a) => !a.startsWith('--')), 'f')) return deny('git.force', 'moving a branch with force is not allowed');
      const listing = flags.some((f) => /^(-a|-r|-l|--list|--all|--remotes|--show-current|-v|-vv|--verbose|--contains|--merged|--no-merged|--sort.*|--format.*|--points-at)$/.test(f));
      if (positional.length === 0 || listing) return ALLOW;
      return deny('git.worktree-branch-admin', 'creating or renaming branches is the console\'s job');
    }
    case 'update-ref':
      return flags.includes('-d') ? deny('git.delete-ref', 'deleting a ref is not allowed') : deny('git.worktree-branch-admin', 'moving refs is not allowed');
    case 'symbolic-ref':
      return positional.length >= 2 ? deny('git.worktree-branch-admin', 'changing HEAD is not allowed') : ALLOW;
    case 'worktree':
      return positional[0] === 'list' ? ALLOW : deny('git.worktree-branch-admin', 'worktrees are managed by the console');
    case 'switch':
      return deny('git.checkout-switch', 'an agent never changes branch');
    case 'checkout': {
      if (flags.some((f) => f === '-b' || f === '-B' || f === '--orphan' || f === '--detach' || f === '-d' || f === '-t' || f === '--track')) {
        return deny('git.checkout-switch', 'an agent never changes branch');
      }
      const sep = args.indexOf('--');
      if (sep !== -1) return ALLOW;
      const target = positional[0];
      if (target === undefined) return ALLOW;
      return positional.every((p) => existsSync(win32.resolve(ctx.worktree, p))) ? ALLOW : deny('git.checkout-switch', 'an agent never changes branch');
    }
    case 'merge': case 'rebase': case 'pull': case 'cherry-pick': case 'am':
      return deny('git.merge-rebase-reset-hard', `git ${sub} would rewrite the branch`);
    case 'reset':
      return flags.some((f) => f === '--hard' || f === '--merge' || f === '--keep') ? deny('git.merge-rebase-reset-hard', 'git reset --hard would discard work') : ALLOW;
    case 'config': {
      const read = flags.some((f) => /^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|--show-origin|--show-scope|--name-only)$/.test(f));
      const write = flags.some((f) => /^(--unset|--unset-all|--add|--replace-all|--edit|-e|--rename-section|--remove-section)$/.test(f));
      if (write || (!read && positional.length >= 2)) return deny('git.config-write', 'git config must not be changed by an agent');
      return ALLOW;
    }
    default:
      return ALLOW;
  }
}

function isWildcardTarget(t: string): boolean {
  const n = t.replace(/\\/g, '/').replace(/^\.\//, '');
  return n === '*' || n === '.*' || n === '.' || n === '..' || n === '' || /^\*+\.?\*?$/.test(n) || n === '/*';
}

function rmRule(name: string, argv: string[], ctx: GuardContext, cwd: string, piped: boolean): GuardDecision {
  const rest = argv.slice(1);
  const flags = rest.filter((t) => isFlag(t) || (name !== 'rm' && /^\/[A-Za-z]$/.test(t)));
  let recursive = false;
  if (name === 'rm' || name === 'unlink') recursive = flags.some((f) => f === '--recursive' || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(f));
  else if (name === 'remove-item' || name === 'ri') recursive = flags.some((f) => /^-r(e(c(u(r(s(e)?)?)?)?)?)?$/i.test(f));
  else recursive = flags.some((f) => /^\/s$/i.test(f) || /^-r(e(c(u(r(s(e)?)?)?)?)?)?$/i.test(f)); // rmdir / rd / del are aliases of Remove-Item in PowerShell
  if (!recursive) return ALLOW;
  const targets = rest.filter((t) => !isFlag(t) && !(name !== 'rm' && /^\/[A-Za-z]$/.test(t)));
  if (piped && targets.length === 0) return deny('rm.wide', 'a recursive delete of piped input cannot be checked');
  for (const t of targets) {
    if (isWildcardTarget(t)) return deny('rm.wide', `recursive delete of ${t} is too wide`);
    const base = t.replace(/[\\/][^\\/]*[*?][^\\/]*$/, '');
    const probe = base === t ? t : base === '' ? '/' : base;
    if (!isInside(ctx.worktree, probe, cwd) || (realResolve(probe, cwd) ?? '').toLowerCase() === (realResolve(ctx.worktree, ctx.worktree) ?? '').toLowerCase()) {
      return deny('rm.wide', `recursive delete of ${t} reaches outside the worktree`);
    }
  }
  return ALLOW;
}

function secretTargets(argv: string[]): string[] {
  const name = commandName(argv[0] ?? '');
  const out: string[] = [];
  const rest = argv.slice(1);
  // redirections into a file
  rest.forEach((t, i) => {
    if (/^\d*>>?$/.test(t) && rest[i + 1] !== undefined) out.push(rest[i + 1]!);
    else if (/^\d*>>?[^&>]/.test(t)) out.push(t.replace(/^\d*>>?/, ''));
  });
  const isGit = name === 'git';
  if (FILE_READERS.has(name) || (isGit && ['add', 'show', 'diff', 'blame'].includes(parseGit(argv).sub))) {
    let args = isGit ? parseGit(argv).args : rest;
    args = args.filter((t) => !isFlag(t) && !/^\d*>/.test(t) && !/^&?>/.test(t));
    if (PATTERN_FIRST.has(name) && !argv.some((t) => t === '-e' || t === '-f' || t === '--regexp')) args = args.slice(1);
    out.push(...args);
  }
  return out;
}

const isSecret = (path: string, patterns: string[]): boolean => {
  const base = baseName(path.replace(/^["']|["']$/g, ''));
  if (TEMPLATE_SUFFIX.test(base)) return false;
  return findSecrets([path.replace(/^["']|["']$/g, '')], patterns).length > 0;
};

/** `.git/hooks/...` and the console's own `console-hooks` folder (the release token lives there). */
function isHooksPath(p: string): boolean {
  const parts = p.split(/[\\/]+/).map((c) => c.toLowerCase());
  return parts.includes('console-hooks') || parts.some((c, i) => c === '.git' && parts[i + 1] === 'hooks');
}

function hooksTarget(argv: string[]): string | undefined {
  const name = commandName(argv[0] ?? '');
  const rest = argv.slice(1);
  const candidates: string[] = [];
  rest.forEach((t, i) => {
    if (/^\d*>>?$/.test(t) && rest[i + 1] !== undefined) candidates.push(rest[i + 1]!);
    else if (/^\d*>>?[^&>]/.test(t)) candidates.push(t.replace(/^\d*>>?/, ''));
  });
  if (WRITERS.has(name)) candidates.push(...rest.filter((t) => !isFlag(t)));
  return candidates.find(isHooksPath);
}

function dotGitTarget(argv: string[]): string | undefined {
  const name = commandName(argv[0] ?? '');
  const rest = argv.slice(1);
  const candidates: string[] = [];
  rest.forEach((t, i) => {
    if (/^\d*>>?$/.test(t) && rest[i + 1] !== undefined) candidates.push(rest[i + 1]!);
    else if (/^\d*>>?[^&>]/.test(t)) candidates.push(t.replace(/^\d*>>?/, ''));
  });
  if (WRITERS.has(name)) candidates.push(...rest.filter((t) => !isFlag(t)));
  return candidates.find((t) => hasComponent(t, '.git') || hasComponent(t, 'console-hooks'));
}

function downloadRule(segments: Segment[]): GuardDecision | undefined {
  const saved: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    const name = commandName(s.argv[0]!);
    if (DOWNLOADERS.has(name) && segments[i + 1]?.pipeFromPrev === true && EXEC_SINKS.has(commandName(segments[i + 1]!.argv[0]!))) {
      return deny('net.download-exec', 'piping a download into an interpreter is not allowed');
    }
    if ((EXEC_SINKS.has(name) || name === 'iex' || name === 'invoke-expression') && DOWNLOAD_RAW.test(s.raw)) {
      return deny('net.download-exec', 'running downloaded text is not allowed');
    }
    if (DOWNLOADERS.has(name)) {
      s.argv.forEach((t, j) => {
        const out = /^(-o|-O|--output|-outfile|-out)$/i.test(t) ? s.argv[j + 1] : undefined;
        if (out !== undefined && EXEC_EXT.test(out)) saved.push(baseName(out).toLowerCase());
      });
    }
    if (saved.length > 0 && i > 0) {
      const ran = [s.argv[0]!, s.argv[1] ?? ''].map((t) => baseName(t).toLowerCase());
      if (ran.some((t) => saved.includes(t))) return deny('net.download-exec', 'running a file just downloaded is not allowed');
    }
  }
  return undefined;
}

function evaluateShell(call: GuardCall, ctx: GuardContext): GuardDecision {
  const command = typeof call.input.command === 'string' ? call.input.command : '';
  const shell: ShellKind = call.tool === 'PowerShell' ? 'powershell' : 'posix';
  const segments = splitCommand(command, shell);
  const dl = downloadRule(segments);
  if (dl !== undefined) return dl;
  // Where the next command runs: a `cd ..` earlier in the same command moves every relative path after it.
  let cwd = ctx.worktree;
  const driveRoot = win32.parse(ctx.worktree).root;
  for (const s of segments) {
    const name = commandName(s.argv[0]!);
    if (CD_COMMANDS.has(name)) {
      const target = s.argv.slice(1).find((t) => !isFlag(t));
      cwd = target === undefined ? driveRoot : (realResolve(target, cwd) ?? driveRoot);
    }
    if (name === 'git') {
      const d = gitRule(s.argv, ctx);
      if (d.decision === 'deny') return d;
    }
    if (RM_COMMANDS.has(name)) {
      const d = rmRule(name, s.argv, ctx, cwd, s.pipeFromPrev);
      if (d.decision === 'deny') return d;
    }
    if (ctx.readOnly && ctx.role !== 'main') {
      const why = readOnlyViolation(s);
      if (why) return deny(READONLY_RULE, `this session is read-only: ${why}`);
    }
    const secret = secretTargets(s.argv).find((t) => isSecret(t, ctx.secretPatterns));
    if (secret !== undefined) return deny('secret.file', `${baseName(secret)} looks like a secret and must not be touched`);
    if (ctx.role === 'main') {
      const hook = hooksTarget(s.argv);
      if (hook !== undefined) return deny('git.hooks-tamper', `${hook} holds the console push hook`);
    }
    const dot = dotGitTarget(s.argv);
    if (dot !== undefined) return deny('path.git-internals', `${dot} is inside git's own files`);
  }
  return ALLOW;
}

function evaluateFileTool(call: GuardCall, ctx: GuardContext): GuardDecision {
  if (ctx.readOnly && ctx.role !== 'main' && (call.tool === 'Write' || call.tool === 'Edit' || call.tool === 'NotebookEdit')) {
    return deny(READONLY_RULE, 'this session is read-only: it may not write files');
  }
  const raw = call.input.file_path ?? call.input.notebook_path ?? (call.tool === 'Grep' || call.tool === 'Glob' ? call.input.path : undefined);
  if (typeof raw !== 'string' || raw === '') return ALLOW;
  if (isSecret(raw, ctx.secretPatterns)) return deny('secret.file', `${baseName(raw)} looks like a secret and must not be touched`);
  if (call.tool === 'Read' || call.tool === 'Grep' || call.tool === 'Glob') return ALLOW;
  if (ctx.role === 'main' && isHooksPath(raw)) return deny('git.hooks-tamper', `${raw} holds the console push hook`);
  if (hasComponent(raw, '.git')) return deny('path.git-internals', `${raw} is inside git's own files`);
  if (!isInside(ctx.worktree, raw, ctx.worktree)) return deny('path.outside-worktree', `${raw} is outside the agent's worktree`);
  const real = realResolve(raw, ctx.worktree);
  if (real !== null && hasComponent(real.slice(realResolve(ctx.worktree, ctx.worktree)?.length ?? 0), '.git')) {
    return deny('path.git-internals', `${raw} is inside git's own files`);
  }
  return ALLOW;
}

const SIGNATURE_KEYS = ['command', 'file_path', 'notebook_path', 'path'] as const;
/** Identifies a call for the loop check: the tool plus the fields the guard sees, in a fixed order (null when absent). */
export const callSignature = (tool: string, input: Record<string, unknown>): string =>
  `${tool}:${JSON.stringify(SIGNATURE_KEYS.map((k) => (typeof input[k] === 'string' ? input[k] : null)))}`;

/**
 * Pure rule evaluation (SPEC 14.2). Anything that is not covered by an explicit rule is allowed. The console's own tools never come
 * here (the mod guards only the engine's tools): their handlers answer a restricted session themselves.
 */
export function evaluate(call: GuardCall, baseCtx: GuardContext): GuardDecision {
  const ctx: GuardContext = { ...baseCtx, role: call.role };
  if (call.role === 'agent' && ctx.restricted) {
    const r = ctx.restricted;
    if (r.reason === 'loop') {
      if (r.signature !== undefined && callSignature(call.tool, call.input) === r.signature) return deny('loop.repeat', 'this exact call was repeated without progress: change approach or report_blocked');
    } else {
      return deny(r.reason === 'budget' ? 'budget.limit' : 'quota.limit', r.reason === 'budget'
        ? 'the token budget of this ticket is used up: only step_done is allowed now (close the step with it)'
        : 'the subscription limit is reached: only step_done is allowed now (close the step with it)');
    }
  }
  let d: GuardDecision = ALLOW;
  switch (call.tool) {
    case 'Bash': case 'PowerShell': d = evaluateShell(call, ctx); break;
    case 'Write': case 'Edit': case 'Read': case 'NotebookEdit': case 'Grep': case 'Glob': d = evaluateFileTool(call, ctx); break;
    case 'Agent': case 'Task': {
      // The main does file-changing work through console agents (spawn_agent): a built-in subagent has no worktree, ticket or budget.
      const type = typeof call.input.subagent_type === 'string' ? call.input.subagent_type.toLowerCase() : '';
      if (call.role === 'main' && !READONLY_SUBAGENTS.has(type)) {
        return deny('agent.builtin-subagent', 'built-in subagents are not visible to the console (no worktree, ticket or budget): start a console agent with mcp__console-mod__spawn_agent for this job (load it with ToolSearch). Only Explore/Plan look-ups are allowed here.');
      }
      return ALLOW;
    }
    default: return ALLOW;
  }
  if (d.decision === 'deny' && call.role === 'main' && !MAIN_RULES.has(d.rule)) return ALLOW;
  return d;
}
