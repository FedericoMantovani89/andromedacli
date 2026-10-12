import { homedir } from 'node:os';
import { join } from 'node:path';
import { evaluate, type GuardContext } from '../src/server/guard/rules';
import { DEFAULT_SECRET_PATTERNS } from '../src/server/git/secrets';

/**
 * Folders that need not exist: the guard reads them as text (and through their deepest existing parent). They sit under the home
 * folder, not under the system temp folder, because the temp folder is the one place a shell may write to outside the worktree.
 */
const base = join(homedir(), 'guard-table-test');
export const WORKTREE = join(base, 'repo.worktrees', 'job');
export const REPO = join(base, 'repo');
export const OUTSIDE = join(base, 'outside');
export const fwd = (p: string): string => p.replace(/\\/g, '/');

export const ctx: GuardContext = {
  worktree: WORKTREE, repo: REPO, branch: 'agent/p/job', projectBranch: 'project/p', secretPatterns: DEFAULT_SECRET_PATTERNS,
};

export type Expected = 'ALLOW' | string;
export type Row = [command: string, expected: Expected];

/** What the guard says about a shell command: 'ALLOW', or the id of the rule that denies it. The main works in the repository, an agent in its worktree. */
export function verdict(command: string, o: { tool?: 'Bash' | 'PowerShell'; role?: 'agent' | 'main'; readOnly?: boolean } = {}): Expected {
  const role = o.role ?? 'agent';
  const c: GuardContext = { ...ctx, ...(role === 'main' ? { worktree: REPO } : {}), ...(o.readOnly ? { readOnly: true } : {}) };
  const d = evaluate({ role, tool: o.tool ?? 'Bash', input: { command } }, c);
  return d.decision === 'allow' ? 'ALLOW' : d.rule;
}

/** The same for a file tool (Read, Write, Edit) of an agent. */
export function fileVerdict(tool: 'Read' | 'Write' | 'Edit', file_path: string): Expected {
  const d = evaluate({ role: 'agent', tool, input: { file_path } }, ctx);
  return d.decision === 'allow' ? 'ALLOW' : d.rule;
}
