import { it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanStore } from '../src/server/plan-store';

const fresh = () => { const root = mkdtempSync(join(tmpdir(), 'plan-resume-')); const s = new PlanStore(root); s.init('shop'); return { root, s }; };

it('updateAgent merges fields, removes keys set to undefined and ignores unknown slugs', () => {
  const { root, s } = fresh();
  s.addAgent({ slug: 'a', profile: 'backend', model: 'opus' });
  s.updateAgent('a', { sessionId: 'x', lastState: 'working', stale: true });
  s.updateAgent('a', { stale: undefined, lastState: 'idle' });
  s.updateAgent('nobody', { lastState: 'idle' });
  const rec = new PlanStore(root).listAgents()[0]!;
  expect(rec).toMatchObject({ slug: 'a', profile: 'backend', model: 'opus', sessionId: 'x', lastState: 'idle' });
  expect('stale' in rec).toBe(false);
  expect(new PlanStore(root).listAgents()).toHaveLength(1);
});
it('old records without the new fields stay valid', () => {
  const { s } = fresh();
  s.addAgent({ slug: 'a', profile: 'dba' });
  expect(s.listAgents()[0]).toEqual({ slug: 'a', profile: 'dba', createdAt: expect.any(String) });
});
it('keeps the main session id and the clean-stop flag', () => {
  const { root, s } = fresh();
  expect(s.readMainSession()).toBeUndefined();
  expect(s.readCleanStop()).toBe(true); // no file: a first run
  s.writeMainSession('11111111-1111-1111-1111-111111111111');
  s.writeCleanStop(false);
  const again = new PlanStore(root);
  expect(again.readMainSession()).toBe('11111111-1111-1111-1111-111111111111');
  expect(again.readCleanStop()).toBe(false);
  again.writeCleanStop(true);
  expect(new PlanStore(root).readCleanStop()).toBe(true);
});

it('an agent record keeps the repository of its worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'ps-repo-'));
  const s = new PlanStore(root);
  s.init('p');
  s.addAgent({ slug: 'a', profile: 'backend' });
  s.updateAgent('a', { repo: 'R' });
  expect(s.listAgents()[0]?.repo).toBe('R');
});
