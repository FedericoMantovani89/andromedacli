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
  | { ok: false; code: 'secrets' | 'index_locked' | 'failed'; files?: string[]; detail?: string };

const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * One commit per closed checklist step, made by the console (SPEC 9.3). Every step commits (empty ones too). Staged files are
 * checked against the secret patterns first: on a match nothing is committed and everything is unstaged.
 */
export async function commitStep(o: {
  worktree: string; n: number; total: number; title: string; slug: string; plan: string; secretPatterns: string[];
}): Promise<CommitResult> {
  const lock = await git(o.worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'index.lock']);
  if (lock.code === 0 && existsSync(lock.stdout.trim())) return { ok: false, code: 'index_locked', detail: lock.stdout.trim() };

  const added = await git(o.worktree, ['add', '-A']);
  if (added.code !== 0) {
    return /index\.lock/.test(added.stderr) ? { ok: false, code: 'index_locked', detail: added.stderr.trim() } : { ok: false, code: 'failed', detail: added.stderr.trim() };
  }
  const staged = await git(o.worktree, ['diff', '--cached', '--name-only', '-z']);
  const files = staged.stdout.split('\0').filter(Boolean);
  const secrets = findSecrets(files, o.secretPatterns);
  if (secrets.length > 0) {
    await git(o.worktree, ['reset', '-q']);
    return { ok: false, code: 'secrets', files: secrets };
  }

  const identity: string[] = [];
  const name = await git(o.worktree, ['config', 'user.name']);
  const email = await git(o.worktree, ['config', 'user.email']);
  if (name.stdout.trim() === '') identity.push('-c', 'user.name=console');
  if (email.stdout.trim() === '') identity.push('-c', 'user.email=console@localhost');

  const subject = `step ${o.n}/${o.total}: ${oneLine(o.title)}`;
  const trailers = `Agent: ${o.slug}\nTicket: ${o.slug}\nPiano: ${o.plan}`;
  const committed = await git(o.worktree, [...identity, 'commit', '--allow-empty', '--no-verify', '-q', '-m', subject, '-m', trailers]);
  if (committed.code !== 0) {
    const text = `${committed.stderr}\n${committed.stdout}`.trim();
    return /index\.lock/.test(text) ? { ok: false, code: 'index_locked', detail: text } : { ok: false, code: 'failed', detail: `exit ${committed.code}: ${text}` };
  }
  const sha = await git(o.worktree, ['rev-parse', 'HEAD']);
  return { ok: true, sha: sha.stdout.trim() };
}
