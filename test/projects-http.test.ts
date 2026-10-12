import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { autoClose, bootServer, req, ui } from './helpers';

autoClose();

describe('POST /api/projects', () => {
  it('auto: the folder alone is enough, the template and the commands come from what it holds', async () => {
    const s = await bootServer();
    const java = mkdtempSync(join(tmpdir(), 'project-auto-j-'));
    writeFileSync(join(java, 'pom.xml'), '<project/>');
    const made = await ui(s, '/api/projects', 'POST', { root: java, auto: true });
    expect(made.status).toBe(201);
    const project = JSON.parse(readFileSync(join(java, '.andromedaconsole', 'project.json'), 'utf8'));
    expect(project.testCommand).toMatch(/test/);
    expect(existsSync(join(java, '.andromedaconsole', 'rules.md'))).toBe(true);
    const plain = mkdtempSync(join(tmpdir(), 'project-auto-g-'));
    expect((await ui(s, '/api/projects', 'POST', { root: plain, auto: true })).status).toBe(201);
    expect(existsSync(join(plain, '.andromedaconsole', 'project.json'))).toBe(true);
  });

  it('copyFrom starts a project with the settings of an open one; copy-settings does it for an open project', async () => {
    const s = await bootServer({ projectName: 'alpha-project' });
    expect((await ui(s, '/api/project?project=alpha-project', 'PUT', { testCommand: 'make check', model: 'opus', maxActive: 2 })).status).toBe(200);
    const dir = mkdtempSync(join(tmpdir(), 'project-copy-'));
    const made = await ui(s, '/api/projects', 'POST', { root: dir, name: 'copy-project', copyFrom: 'alpha-project' });
    expect([made.status, made.body.name]).toEqual([201, 'copy-project']);
    const copied = JSON.parse(readFileSync(join(dir, '.andromedaconsole', 'project.json'), 'utf8'));
    expect(copied).toMatchObject({ name: 'copy-project', testCommand: 'make check', model: 'opus', maxActive: 2 });
    const unknown = await ui(s, '/api/projects', 'POST', { root: mkdtempSync(join(tmpdir(), 'project-copy-')), copyFrom: 'nobody-here' });
    expect([unknown.status, unknown.body.code]).toEqual([404, 'project.notFound']);
    // an open project takes the settings of another one
    const other = mkdtempSync(join(tmpdir(), 'project-copy-'));
    expect((await ui(s, '/api/projects', 'POST', { root: other, name: 'plain-project' })).status).toBe(201);
    expect((await ui(s, '/api/projects/copy-settings?project=plain-project', 'POST', { from: 'alpha-project' })).status).toBe(200);
    expect((await ui(s, '/api/state?project=plain-project')).body.project).toMatchObject({ testCommand: 'make check', model: 'opus' });
    expect((await ui(s, '/api/projects/copy-settings?project=plain-project', 'POST', { from: 'plain-project' })).status).toBe(404);
  });

  it('needs the token', async () => {
    const s = await bootServer();
    expect((await req(s, '/api/projects', { method: 'POST', body: { root: tmpdir() } })).status).toBe(401);
  });

  it('refuses a body without a root, a relative root and a missing folder', async () => {
    const s = await bootServer();
    expect((await ui(s, '/api/projects', 'POST', {})).status).toBe(400);
    const rel = await ui(s, '/api/projects', 'POST', { root: 'relative/dir' });
    expect([rel.status, rel.body.code]).toEqual([422, 'project.badRoot']);
    const missing = await ui(s, '/api/projects', 'POST', { root: join(tmpdir(), 'does-not-exist-6c') });
    expect([missing.status, missing.body.code]).toEqual([422, 'project.badRoot']);
  });

  it('refuses a bad name and a folder that is already open', async () => {
    const s = await bootServer();
    const dir = mkdtempSync(join(tmpdir(), 'project-c-'));
    const bad = await ui(s, '/api/projects', 'POST', { root: dir, name: 'Bad Name' });
    expect([bad.status, bad.body.code]).toEqual([422, 'project.badName']);
    const ok = await ui(s, '/api/projects', 'POST', { root: dir, name: 'gamma-project', test: 'npm test', build: 'npm run build' });
    expect([ok.status, ok.body.name]).toEqual([201, 'gamma-project']);
    const dup = await ui(s, '/api/projects', 'POST', { root: dir, name: 'delta-project' });
    expect([dup.status, dup.body.code]).toEqual([409, 'project.duplicate']);
    expect((await ui(s, '/api/state?project=gamma-project')).body.project.testCommand).toBe('npm test');
  });

  it('creates a missing folder when asked', async () => {
    const s = await bootServer();
    const root = join(mkdtempSync(join(tmpdir(), 'project-d-')), 'fresh-folder');
    const made = await ui(s, '/api/projects', 'POST', { root, create: true });
    expect(made.status).toBe(201);
    expect(made.body.name).toBe('fresh-folder');
  });

  it('DELETE closes a project, also the last one', async () => {
    const s = await bootServer({ projectName: 'alpha-project' });
    const dir = mkdtempSync(join(tmpdir(), 'project-e-'));
    await ui(s, '/api/projects', 'POST', { root: dir, name: 'eps-project' });
    expect((await ui(s, '/api/projects/eps-project', 'DELETE')).status).toBe(200);
    expect((await ui(s, '/api/projects/eps-project', 'DELETE')).body.code).toBe('project.notFound');
    expect((await ui(s, '/api/projects/alpha-project', 'DELETE')).status).toBe(200);
  });
});
