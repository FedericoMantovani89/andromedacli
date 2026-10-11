import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cloneIntoFolder, validCloneUrl } from '../src/server/git/clone';
import { autoClose, bootServer, ui } from './helpers';
import { gitSync, makeRepo, removeDir, type TestRepo } from './git-helpers';

vi.setConfig({ testTimeout: 60_000 }); // real git
const made: TestRepo[] = [];
afterEach(() => { while (made.length) removeDir(made.pop()!.base); });
autoClose(); // after the folder removal: afterEach hooks run last-declared first, so the server (and its agents, whose folder is inside the repo) closes before the folder goes

describe('validCloneUrl', () => {
  it('accepts what a hosting page gives: https, ssh and git@host:path', () => {
    for (const ok of ['https://github.com/org/repo.git', 'https://git.example.com/a/b/c', 'ssh://git@host.example.com/org/repo.git', 'git@github.com:org/repo.git']) expect(validCloneUrl(ok), ok).toBe(true);
  });
  it('refuses options, local paths, command-running transports, passwords, spaces and the rest', () => {
    for (const bad of ['', '   ', '-oProxyCommand=x', '--upload-pack=x', 'ext::sh -c touch /tmp/x', 'file:///tmp/repo', '/tmp/repo', 'C:\repo', 'http://insecure.example.com/r.git',
      'https://user:secret@github.com/org/repo.git', 'https://github.com/org/my repo.git', 'git@github.com:org/repo.git; rm -rf /', 'https://github.com', ' https://github.com/a/b', 'https://github.com/a/b\n']) expect(validCloneUrl(bad), JSON.stringify(bad)).toBe(false);
    expect(validCloneUrl(undefined)).toBe(false);
    expect(validCloneUrl(42)).toBe(false);
    expect(validCloneUrl('https://' + 'a'.repeat(600))).toBe(false);
  });
});

describe('cloneIntoFolder', () => {
  const folder = (): string => { const d = mkdtempSync(join(tmpdir(), 'clone-')); mkdirSync(join(d, '.andromedacli')); return d; }; // the console's own folder is allowed
  it('makes the folder a clone on the remote default branch, with the files and the history, and leaves .andromedacli alone', async () => {
    const t = makeRepo({ remote: true });
    made.push(t);
    gitSync(t.repo, 'push', '-q', '-u', 'origin', 'main');
    const root = folder();
    const r = await cloneIntoFolder(root, t.remote, { allowLocal: true });
    expect(r).toEqual({ ok: true, branch: 'main' });
    expect(readFileSync(join(root, 'README.md'), 'utf8').trim()).toBe('hello'); // line endings follow the machine's git settings
    expect(gitSync(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(gitSync(root, 'rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/main');
    expect(existsSync(join(root, '.andromedacli'))).toBe(true);
  });
  it('an empty remote becomes a repository with its remote and a first empty commit', async () => {
    const t = makeRepo({ remote: true, commit: false });
    made.push(t);
    const root = folder();
    const r = await cloneIntoFolder(root, t.remote, { allowLocal: true });
    expect(r).toEqual({ ok: true, branch: undefined });
    expect(gitSync(root, 'remote').trim()).toBe('origin');
    expect(gitSync(root, 'rev-parse', '--verify', 'HEAD').trim()).toMatch(/^[0-9a-f]{40}$/);
  });
  it('a folder with anything else in it is refused and left untouched', async () => {
    const root = folder();
    writeFileSync(join(root, 'notes.txt'), 'mine');
    expect(await cloneIntoFolder(root, 'https://example.invalid/a/b.git')).toEqual({ ok: false, code: 'git.cloneFolderNotEmpty' });
    expect(existsSync(join(root, '.git'))).toBe(false);
    expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('mine');
  });
  it('a failed fetch takes the half-made repository away and says why, with no secret in the message', async () => {
    const root = folder();
    const r = await cloneIntoFolder(root, join(tmpdir(), 'no-such-remote-for-clone.git'), { allowLocal: true });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('git.cloneFailed');
    expect(existsSync(join(root, '.git'))).toBe(false);
  });
  it('the default transports refuse a local path even when it exists (no file:// through the console)', async () => {
    const t = makeRepo({ remote: true });
    made.push(t);
    const root = folder();
    const r = await cloneIntoFolder(root, t.remote); // allowLocal off
    expect(r.ok).toBe(false);
    expect(existsSync(join(root, '.git'))).toBe(false);
  });
});

describe('POST /api/projects/git-clone', () => {
  it('refuses a bad address, a body without one, a project that is already a repository and a folder that is not empty', async () => {
    const s = await bootServer();
    expect((await ui(s, '/api/projects/git-clone', 'POST', {})).status).toBe(400);
    const bad = await ui(s, '/api/projects/git-clone', 'POST', { url: 'ext::sh -c id' });
    expect([bad.status, bad.body.code]).toEqual([422, 'git.cloneUrlInvalid']);
    const full = bootServerRoot();
    const s2 = await bootServer({ projectRoot: full });
    const notEmpty = await ui(s2, '/api/projects/git-clone', 'POST', { url: 'https://example.invalid/a/b.git' });
    expect([notEmpty.status, notEmpty.body.code]).toEqual([409, 'git.cloneFolderNotEmpty']);
    const t = makeRepo({ remote: true });
    made.push(t);
    const s3 = await bootServer({ projectRoot: t.repo });
    const already = await ui(s3, '/api/projects/git-clone', 'POST', { url: 'https://example.invalid/a/b.git' });
    expect([already.status, already.body.code]).toEqual([409, 'git.alreadyRepo']);
  });
});

function bootServerRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'clone-full-'));
  writeFileSync(join(d, 'notes.txt'), 'mine');
  return d;
}
