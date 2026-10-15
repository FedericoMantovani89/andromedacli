import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { autoClose, bootServer, ui } from './helpers';
import { gitSync } from './git-helpers';

vi.setConfig({ testTimeout: 60_000 });
autoClose();

describe('POST /api/projects/git-init', () => {
  it('makes a folder that is not a repository one (main branch, an empty first commit), once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-init-'));
    const s = await bootServer({ projectRoot: root });
    expect((await ui(s, '/api/state')).body.projectIsRepo).toBe(false);
    const made = await ui(s, '/api/projects/git-init', 'POST', {});
    expect(made.status).toBe(200);
    expect(existsSync(join(root, '.git'))).toBe(true);
    expect(gitSync(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(gitSync(root, 'log', '--format=%s')).toBe('chore: start');
    expect(gitSync(root, 'status', '--porcelain')).toBe(''); // .andromedaconsole is kept out of the status
    expect((await ui(s, '/api/state')).body.projectIsRepo).toBe(true);
    const again = await ui(s, '/api/projects/git-init', 'POST', {});
    expect([again.status, again.body.code]).toEqual([409, 'git.alreadyRepo']);
  });
});

describe('git init in a folder that only holds repositories', () => {
  it('is allowed (the folder itself is no repository) and the folder becomes the project repository, nested ones left alone', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'git-init-mixed-'))); // long form: git reports the folder that way
    mkdirSync(join(root, 'abc-fe'));
    gitSync(join(root, 'abc-fe'), 'init', '-q', '-b', 'main'); // a repository inside, and a plain folder next to it
    mkdirSync(join(root, 'docs'));
    const s = await bootServer({ projectRoot: root });
    const before = (await ui(s, '/api/state')).body;
    expect([before.projectIsRepo, before.repos]).toEqual([true, ['abc-fe']]); // it holds a repository, it is not one
    const made = await ui(s, '/api/projects/git-init', 'POST', {});
    expect(made.status).toBe(200);
    const slash = (p: string): string => p.split('\\').join('/').toLowerCase();
    expect(slash(gitSync(root, 'rev-parse', '--show-toplevel'))).toBe(slash(root));
    const after = (await ui(s, '/api/state')).body;
    expect(after.repos).toEqual(['']); // now the folder is the repository
    const again = await ui(s, '/api/projects/git-init', 'POST', {});
    expect([again.status, again.body.code]).toEqual([409, 'git.alreadyRepo']);
  });
});

describe('POST /api/projects/apply-template', () => {
  it('switches the template: its main.md and rules.md replace the files, the commands already set stay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'apply-tpl-'));
    const s = await bootServer({ projectRoot: root });
    expect((await ui(s, '/api/project', 'PUT', { testCommand: 'my test' })).status).toBe(200);
    const done = await ui(s, '/api/projects/apply-template', 'POST', { templateId: 'frontend-web' });
    expect([done.status, done.body.templateId]).toEqual([200, 'frontend-web']);
    expect(existsSync(join(root, '.andromedaconsole', 'main.md'))).toBe(true);
    expect(readFileSync(join(root, '.andromedaconsole', 'rules.md'), 'utf8')).toMatch(/front end/i);
    expect((await ui(s, '/api/state')).body.project.testCommand).toBe('my test');
  });

  it('refuses an unknown template and a body without one', async () => {
    const s = await bootServer();
    const unknown = await ui(s, '/api/projects/apply-template', 'POST', { templateId: 'nope-nope' });
    expect([unknown.status, unknown.body.code]).toEqual([422, 'template.notFound']);
    expect((await ui(s, '/api/projects/apply-template', 'POST', {})).status).toBe(400);
  });
});

