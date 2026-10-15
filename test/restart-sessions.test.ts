import { describe, expect, it } from 'vitest';
import { autoClose, usePipePty, bootServer, mod, ui, until } from './helpers';

autoClose();
usePipePty(); // this file never reads the terminal: its sessions run on plain pipes

const SID = '3f2c6a52-8b5e-4a49-9d57-0f4f3c1d2a10';

describe('POST /api/restart', () => {
  it('starts the main and the agents that were running again, with the settings saved by then', async () => {
    const s = await bootServer({ projectName: 'alpha-project', config: { git: { worktrees: false } } });
    await until(async () => (await ui(s, '/api/state')).body.main.status === 'running');
    expect((await ui(s, '/api/agents', 'POST', { slug: 'job-one', profile: 'developer' })).status).toBe(201);
    await mod(s, 'job-one', '/v1/events', 'POST', { type: 'session.start', sessionId: SID });
    expect(s.lastLaunchArgs('job-one')).not.toContain('--dangerously-skip-permissions');
    expect((await ui(s, '/api/config', 'PUT', { agents: { bypassPermissions: true } })).status).toBe(200);

    const done = await ui(s, '/api/restart', 'POST');
    expect(done.status).toBe(200);

    await until(async () => (await ui(s, '/api/state')).body.main.status === 'running');
    // The agent came back through `--resume` of its own session, and with the new setting.
    await until(() => s.lastLaunchArgs('job-one')?.includes('--resume') === true);
    expect(s.lastLaunchArgs('job-one')).toEqual(expect.arrayContaining(['--resume', SID, '--dangerously-skip-permissions']));
    expect(s.lastLaunchArgs('alpha-project')).toContain('--dangerously-skip-permissions');
    // Same console, same token: the page keeps working after it loads again.
    expect((await ui(s, '/api/state')).status).toBe(200);
  });

  it('never reads the PATH from the system: the one the console was started with is the one the sessions get', async () => {
    const before = process.env.PATH;
    const marker = `${before ?? ''};C:\\only-from-the-start`;
    process.env.PATH = marker;
    try {
      const s = await bootServer({ projectName: 'alpha-project', config: { git: { worktrees: false } } });
      await until(async () => (await ui(s, '/api/state')).body.main.status === 'running');
      expect((await ui(s, '/api/restart', 'POST')).status).toBe(200);
      expect(process.env.PATH).toBe(marker); // nothing merged in from the registry or anywhere else
    } finally {
      process.env.PATH = before;
    }
  });

  it('refuses without the token', async () => {
    const s = await bootServer();
    const res = await fetch(`${s.url}/api/restart`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
