import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { autoClose, bootServer, configFileOf, modEvent, req, ui, until } from './helpers';

autoClose();

const newDir = (): string => mkdtempSync(join(tmpdir(), 'project-b-'));
const projectsFileOf = (s: Awaited<ReturnType<typeof bootServer>>): string => join(configFileOf(s), '..', 'projects.json');

describe('projects host', () => {
  it('opens a second project with its own state, and ?project= selects it', async () => {
    const s = await bootServer({ projectName: 'alpha-project' });
    const dir = newDir();
    const added = await s.addProject(dir, 'beta-project');
    expect(added.name).toBe('beta-project');
    const a = (await ui(s, '/api/state')).body;
    const b = (await ui(s, '/api/state?project=beta-project')).body;
    expect(a.project.name).toBe('alpha-project');
    expect(b.project.name).toBe('beta-project');
    expect(b.projectRoot).toBe(dir);
    expect(a.projects.map((p: { name: string }) => p.name)).toEqual(['alpha-project', 'beta-project']);
    // An agent made in project B is not in project A.
    const made = await ui(s, '/api/agents?project=beta-project', 'POST', { slug: 'worker-one', profile: 'backend' });
    expect([201, 202]).toContain(made.status);
    expect((await ui(s, '/api/state')).body.agents).toEqual([]);
    await until(async () => (await ui(s, '/api/state?project=beta-project')).body.agents.length === 1);
  });

  it('answers 404 for an unknown project', async () => {
    const s = await bootServer();
    expect((await ui(s, '/api/state?project=nope-project')).status).toBe(404);
  });

  it('routes /v1 by the session token of the project that issued it', async () => {
    const s = await bootServer({ projectName: 'alpha-project' });
    await s.addProject(newDir(), 'beta-project');
    await until(async () => (await ui(s, '/api/state?project=beta-project')).body.main.status === 'running');
    // Project A's token still works; a token of project B's main is found in B's table (the host looks through every project), a made-up one is not.
    expect((await modEvent(s, 'alpha-project', 'turn.start')).status).toBe(204);
    expect((await req(s, '/v1/inbox', { token: 'not-a-token' })).status).toBe(401);
  });

  it('counts active agents of every project against the global limit', async () => {
    const s = await bootServer({ projectName: 'alpha-project', config: { agents: { maxActiveGlobal: 1, maxActivePerProject: 3 } } });
    await s.addProject(newDir(), 'beta-project');
    const one = await ui(s, '/api/agents', 'POST', { slug: 'first-one', profile: 'backend' });
    expect(one.status).toBe(201);
    const two = await ui(s, '/api/agents?project=beta-project', 'POST', { slug: 'second-one', profile: 'backend' });
    expect(two.status).toBe(202); // queued behind the other project's agent
  });

  it('remembers the open projects in projects.json and refuses duplicates', async () => {
    const s = await bootServer({ projectName: 'alpha-project' });
    const dir = newDir();
    await s.addProject(dir, 'beta-project');
    const saved = JSON.parse(readFileSync(projectsFileOf(s), 'utf8')) as { root: string; name: string }[];
    expect(saved.map((p) => p.name)).toEqual(['alpha-project', 'beta-project']);
    await expect(s.addProject(dir, 'other-name')).rejects.toMatchObject({ code: 'project.duplicate' });
    await expect(s.addProject(newDir(), 'beta-project')).rejects.toMatchObject({ code: 'project.duplicate' });
  });

  it('closes a project and leaves its folder; the last project can be closed too; purge also removes .console', async () => {
    const s = await bootServer({ projectName: 'alpha-project' });
    const dir = newDir();
    await s.addProject(dir, 'beta-project');
    await s.closeProject('beta-project');
    expect(s.projects().map((p) => p.name)).toEqual(['alpha-project']);
    expect(existsSync(join(dir, '.console'))).toBe(true);
    expect((await ui(s, '/api/state?project=beta-project')).status).toBe(404);
    await expect(s.closeProject('beta-project')).rejects.toMatchObject({ code: 'project.notFound' });
    const gamma = newDir();
    await s.addProject(gamma, 'gamma-project');
    expect(existsSync(join(gamma, '.console'))).toBe(true);
    await s.closeProject('gamma-project', true);
    expect(existsSync(join(gamma, '.console'))).toBe(false);
    expect(existsSync(gamma)).toBe(true);
    await s.closeProject('alpha-project');
    expect(s.projects()).toEqual([]);
  });
});
