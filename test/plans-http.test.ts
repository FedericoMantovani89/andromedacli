import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { autoClose, bootServer, req, ui } from './helpers';

autoClose();

describe('POST /api/plans', () => {
  it('needs the token', async () => {
    const s = await bootServer();
    expect((await req(s, '/api/plans', { method: 'POST', body: { root: tmpdir() } })).status).toBe(401);
  });

  it('refuses a body without a root, a relative root and a missing folder', async () => {
    const s = await bootServer();
    expect((await ui(s, '/api/plans', 'POST', {})).status).toBe(400);
    const rel = await ui(s, '/api/plans', 'POST', { root: 'relative/dir' });
    expect([rel.status, rel.body.code]).toEqual([422, 'plan.badRoot']);
    const missing = await ui(s, '/api/plans', 'POST', { root: join(tmpdir(), 'does-not-exist-6c') });
    expect([missing.status, missing.body.code]).toEqual([422, 'plan.badRoot']);
  });

  it('refuses a bad name and a folder that is already open', async () => {
    const s = await bootServer();
    const dir = mkdtempSync(join(tmpdir(), 'plan-c-'));
    const bad = await ui(s, '/api/plans', 'POST', { root: dir, name: 'Bad Name' });
    expect([bad.status, bad.body.code]).toEqual([422, 'plan.badName']);
    const ok = await ui(s, '/api/plans', 'POST', { root: dir, name: 'gamma-plan', test: 'npm test', build: 'npm run build' });
    expect([ok.status, ok.body.name]).toEqual([201, 'gamma-plan']);
    const dup = await ui(s, '/api/plans', 'POST', { root: dir, name: 'delta-plan' });
    expect([dup.status, dup.body.code]).toEqual([409, 'plan.duplicate']);
    expect((await ui(s, '/api/state?plan=gamma-plan')).body.plan.testCommand).toBe('npm test');
  });

  it('creates a missing folder when asked', async () => {
    const s = await bootServer();
    const root = join(mkdtempSync(join(tmpdir(), 'plan-d-')), 'fresh-folder');
    const made = await ui(s, '/api/plans', 'POST', { root, create: true });
    expect(made.status).toBe(201);
    expect(made.body.name).toBe('fresh-folder');
  });

  it('DELETE closes a plan; the last one is refused', async () => {
    const s = await bootServer({ planName: 'alpha-plan' });
    const dir = mkdtempSync(join(tmpdir(), 'plan-e-'));
    await ui(s, '/api/plans', 'POST', { root: dir, name: 'eps-plan' });
    expect((await ui(s, '/api/plans/eps-plan', 'DELETE')).status).toBe(200);
    expect((await ui(s, '/api/plans/eps-plan', 'DELETE')).body.code).toBe('plan.notFound');
    const last = await ui(s, '/api/plans/alpha-plan', 'DELETE');
    expect([last.status, last.body.code]).toEqual([409, 'plan.closeFailed']);
  });
});
