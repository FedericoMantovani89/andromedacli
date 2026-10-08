import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git';
import { initRepo } from '../templates/apply';

/**
 * Only addresses a person would paste from a hosting page: https, ssh or the `git@host:path` form. No userinfo with a password (it would be
 * stored in .git/config), nothing that starts with `-` (an option), no spaces or control characters, and neither a local path nor a
 * transport that runs a command (`ext::`). Git is also told not to use those transports.
 */
export function validCloneUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const url = raw.trim();
  if (url !== raw || url.length < 8 || url.length > 500 || /[\s\u0000-\u001f\u007f]/.test(url) || url.startsWith('-')) return false;
  if (/^(https|ssh):\/\//.test(url)) return !/^[a-z]+:\/\/[^/@]*:[^/@]*@/.test(url) && /^[a-z]+:\/\/[^/@\s]+@?[^/@\s]*\/\S+$/.test(url);
  return /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/.test(url); // git@github.com:org/repo.git
}

export type CloneResult =
  | { ok: true; branch: string | undefined }
  | { ok: false; code: 'git.cloneFolderNotEmpty' | 'git.cloneFailed'; detail?: string };

/** Anything that looks like `user:secret@` in a message is hidden before the message is shown or kept. */
const scrub = (text: string): string => text.replace(/([a-z]+:\/\/)[^/@\s]*@/gi, '$1***@');

const NO_RISKY_TRANSPORT = ['-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never'] as const;
const CLONE_TIMEOUT_MS = 10 * 60_000;

/**
 * Makes the project folder (empty but for the console's own `.andromedacli`) a clone of `url`: `git init`, the remote, a fetch and a
 * checkout of the remote's default branch. It is not `git clone`, which refuses a folder that is not empty. Prompts for a password are
 * turned off (a credential helper still works), and a failed attempt takes the half-made repository away again.
 */
export async function cloneIntoFolder(root: string, url: string, o: { timeoutMs?: number; allowLocal?: boolean } = {}): Promise<CloneResult> {
  let others: string[];
  try { others = readdirSync(root).filter((n) => n !== '.andromedacli'); } catch (e) { return { ok: false, code: 'git.cloneFailed', detail: scrub(e instanceof Error ? e.message : String(e)) }; }
  if (others.length > 0) return { ok: false, code: 'git.cloneFolderNotEmpty' };

  const env = { GIT_TERMINAL_PROMPT: '0' };
  const transport = o.allowLocal ? [] : [...NO_RISKY_TRANSPORT];
  const undo = (): void => { try { rmSync(join(root, '.git'), { recursive: true, force: true }); } catch { /* left for the user to see */ } };
  const failed = (r: { stderr: string }): CloneResult => { undo(); return { ok: false, code: 'git.cloneFailed', detail: scrub(r.stderr.trim().split(/\r?\n/).slice(-3).join(' ')) }; };

  const init = await git(root, ['init', '-q', '-b', 'main']);
  if (init.code !== 0) return failed(init);
  const remote = await git(root, ['remote', 'add', 'origin', url]);
  if (remote.code !== 0) return failed(remote);
  const fetched = await git(root, [...transport, 'fetch', '--quiet', 'origin'], { timeoutMs: o.timeoutMs ?? CLONE_TIMEOUT_MS, env });
  if (fetched.code !== 0) return failed(fetched);

  await git(root, ['remote', 'set-head', 'origin', '--auto'], { env, timeoutMs: 60_000 });
  const head = await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  let branch = head.code === 0 ? head.stdout.trim().replace(/^origin\//, '') : undefined;
  if (!branch) {
    // The remote names no default branch (its HEAD points to one that does not exist): take main, then master, then the first there is.
    const listed = await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin']);
    const names = listed.stdout.split('\n').map((l) => l.trim().replace(/^origin\//, '')).filter((n) => n !== '' && n !== 'HEAD');
    branch = names.includes('main') ? 'main' : names.includes('master') ? 'master' : names[0];
  }
  if (!branch) {
    // A remote with nothing in it yet: keep the repository with its remote and give it the first (empty) commit the console needs.
    const made = await initRepo(root);
    return made.ok ? { ok: true, branch: undefined } : failed({ stderr: made.detail ?? made.code });
  }
  const checkout = await git(root, ['checkout', '-q', '-B', branch, '--track', `origin/${branch}`]);
  return checkout.code === 0 ? { ok: true, branch } : failed(checkout);
}
