import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { autoClose, bootServer, configFileOf, modEvent, req, ui, until } from './helpers';

autoClose();

const newDir = (): string => mkdtempSync(join(tmpdir(), 'plan-b-'));
const plansFileOf = (s: Awaited<ReturnType<typeof bootServer>>): string => join(configFileOf(s), '..', 'plans.json');

describe('plans host', () => {
  it('opens a second plan with its own state, and ?plan= selects it', async () => {
    const s = await bootServer({ planName: 'alpha-plan' });
    const dir = newDir();
    const added = await s.addPlan(dir, 'beta-plan');
    expect(added.name).toBe('beta-plan');
    const a = (await ui(s, '/api/state')).body;
    const b = (await ui(s, '/api/state?plan=beta-plan')).body;
    expect(a.plan.name).toBe('alpha-plan');
    expect(b.plan.name).toBe('beta-plan');
    expect(b.planRoot).toBe(dir);
    expect(a.plans.map((p: { name: string }) => p.name)).toEqual(['alpha-plan', 'beta-plan']);
    // An agent made in plan B is not in plan A.
    const made = await ui(s, '/api/agents?plan=beta-plan', 'POST', { slug: 'worker-one', profile: 'backend' });
    expect([201, 202]).toContain(made.status);
    expect((await ui(s, '/api/state')).body.agents).toEqual([]);
    await until(async () => (await ui(s, '/api/state?plan=beta-plan')).body.agents.length === 1);
  });

  it('answers 404 for an unknown plan', async () => {
    const s = await bootServer();
    expect((await ui(s, '/api/state?plan=nope-plan')).status).toBe(404);
  });

  it('routes /v1 by the session token of the plan that issued it', async () => {
    const s = await bootServer({ planName: 'alpha-plan' });
    await s.addPlan(newDir(), 'beta-plan');
    await until(async () => (await ui(s, '/api/state?plan=beta-plan')).body.main.status === 'running');
    // Plan A's token still works; a token of plan B's main is found in B's table (the host looks through every plan), a made-up one is not.
    expect((await modEvent(s, 'alpha-plan', 'turn.start')).status).toBe(204);
    expect((await req(s, '/v1/inbox', { token: 'not-a-token' })).status).toBe(401);
  });

  it('counts active agents of every plan against the global limit', async () => {
    const s = await bootServer({ planName: 'alpha-plan', config: { agents: { maxActiveGlobal: 1, maxActivePerPlan: 3 } } });
    await s.addPlan(newDir(), 'beta-plan');
    const one = await ui(s, '/api/agents', 'POST', { slug: 'first-one', profile: 'backend' });
    expect(one.status).toBe(201);
    const two = await ui(s, '/api/agents?plan=beta-plan', 'POST', { slug: 'second-one', profile: 'backend' });
    expect(two.status).toBe(202); // queued behind the other plan's agent
  });

  it('remembers the open plans in plans.json and refuses duplicates', async () => {
    const s = await bootServer({ planName: 'alpha-plan' });
    const dir = newDir();
    await s.addPlan(dir, 'beta-plan');
    const saved = JSON.parse(readFileSync(plansFileOf(s), 'utf8')) as { root: string; name: string }[];
    expect(saved.map((p) => p.name)).toEqual(['alpha-plan', 'beta-plan']);
    await expect(s.addPlan(dir, 'other-name')).rejects.toMatchObject({ code: 'plan.duplicate' });
    await expect(s.addPlan(newDir(), 'beta-plan')).rejects.toMatchObject({ code: 'plan.duplicate' });
  });

  it('closes a plan, leaves its folder, and never the last plan', async () => {
    const s = await bootServer({ planName: 'alpha-plan' });
    const dir = newDir();
    await s.addPlan(dir, 'beta-plan');
    await s.closePlan('beta-plan');
    expect(s.plans().map((p) => p.name)).toEqual(['alpha-plan']);
    expect(existsSync(join(dir, '.console'))).toBe(true);
    expect((await ui(s, '/api/state?plan=beta-plan')).status).toBe(404);
    await expect(s.closePlan('alpha-plan')).rejects.toMatchObject({ code: 'plan.closeFailed' });
    await expect(s.closePlan('beta-plan')).rejects.toMatchObject({ code: 'plan.notFound' });
  });
});
