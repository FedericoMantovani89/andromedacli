import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { autoClose, bootServer, req, ui } from './helpers';

autoClose();

describe('POST /api/projects', () => {
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
