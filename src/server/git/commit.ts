import { existsSync } from 'node:fs';
import { git } from './git';
import { findSecrets } from './secrets';

/** `-c user.name/email` for a repository that has no identity configured, so the console's own commits never fail for that. */
export async function identityArgs(cwd: string): Promise<string[]> {
  const name = await git(cwd, ['config', 'user.name']);
  const email = await git(cwd, ['config', 'user.email']);
  return [...(name.stdout.trim() === '' ? ['-c', 'user.name=console'] : []), ...(email.stdout.trim() === '' ? ['-c', 'user.email=console@localhost'] : [])];
}

export type CommitResult =
  | { ok: true; sha: string }
  | { ok: false; code: 'secrets' | 'index_locked' | 'failed' | 'merging'; files?: string[]; detail?: string };

const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * One commit per closed checklist step, made by the console (SPEC 9.3). Every step commits (empty ones too). Staged files are
 * checked against the secret patterns first: on a match nothing is committed and everything is unstaged.
 */
export async function commitStep(o: {
  worktree: string; n: number; total: number; title: string; slug: string; project: string; secretPatterns: string[];
}): Promise<CommitResult> {
  const staged = await stageAll(o.worktree, o.secretPatterns);
  if (!staged.ok) return staged;
  return commitStaged(o.worktree, `step ${o.n}/${o.total}: ${oneLine(o.title)}`, o, true);
}

/**
 * A work-in-progress commit made by the console (a budget alert or stop, SPEC 16.3): subject `wip: <reason>`, the same trailers,
 * secret check and identity as a step. Unlike a step it is never empty: with nothing staged no commit is made and HEAD is returned.
 */
export async function commitWip(o: { worktree: string; slug: string; project: string; reason: string; secretPatterns: string[] }): Promise<CommitResult> {
  // A merge in progress (a conflict the author is resolving): committing would conclude it with the markers in. Nothing is touched.
  const merging = await git(o.worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (merging.code === 0) return { ok: false, code: 'merging', detail: `a merge is in progress (MERGE_HEAD ${merging.stdout.trim()})` };
  const staged = await stageAll(o.worktree, o.secretPatterns);
  if (!staged.ok) return staged;
  if (staged.files.length === 0) {
    const head = await git(o.worktree, ['rev-parse', 'HEAD']);
    return head.code === 0 ? { ok: true, sha: head.stdout.trim() } : { ok: false, code: 'failed', detail: head.stderr.trim() };
  }
  return commitStaged(o.worktree, `wip: ${oneLine(o.reason)}`, o, false);
}

/** Stages everything, refusing (and unstaging) when a staged file matches a secret pattern, or when the index is locked. */
async function stageAll(worktree: string, secretPatterns: string[]): Promise<{ ok: true; files: string[] } | Extract<CommitResult, { ok: false }>> {
  const lock = await git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'index.lock']);
  if (lock.code === 0 && existsSync(lock.stdout.trim())) return { ok: false, code: 'index_locked', detail: lock.stdout.trim() };

  const added = await git(worktree, ['add', '-A']);
  if (added.code !== 0) {
    return /index\.lock/.test(added.stderr) ? { ok: false, code: 'index_locked', detail: added.stderr.trim() } : { ok: false, code: 'failed', detail: added.stderr.trim() };
  }
  const staged = await git(worktree, ['diff', '--cached', '--name-only', '-z']);
  const files = staged.stdout.split('\0').filter(Boolean);
  const secrets = findSecrets(files, secretPatterns);
  if (secrets.length > 0) {
    await git(worktree, ['reset', '-q']);
    return { ok: false, code: 'secrets', files: secrets };
  }
  return { ok: true, files };
}

async function commitStaged(worktree: string, subject: string, o: { slug: string; project: string }, allowEmpty: boolean): Promise<CommitResult> {
  const identity = await identityArgs(worktree);
  const trailers = `Agent: ${o.slug}\nTicket: ${o.slug}\nProgetto: ${o.project}`;
  const committed = await git(worktree, [...identity, 'commit', ...(allowEmpty ? ['--allow-empty'] : []), '--no-verify', '-q', '-m', subject, '-m', trailers]);
  if (committed.code !== 0) {
    const text = `${committed.stderr}\n${committed.stdout}`.trim();
    return /index\.lock/.test(text) ? { ok: false, code: 'index_locked', detail: text } : { ok: false, code: 'failed', detail: `exit ${committed.code}: ${text}` };
  }
  const sha = await git(worktree, ['rev-parse', 'HEAD']);
  return { ok: true, sha: sha.stdout.trim() };
}
