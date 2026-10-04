import { it, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanStore } from '../src/server/plan-store';

const repo = () => mkdtempSync(join(tmpdir(), 'plan-'));
it('init creates plan.json and an empty agents.json', () => {
  const root = repo(); const s = new PlanStore(root); s.init('shop-api');
  expect(existsSync(join(root, '.console', 'plan.json'))).toBe(true);
  expect(existsSync(join(root, '.console', 'state', 'agents.json'))).toBe(true);
  expect(s.plan.name).toBe('shop-api');
  expect(s.listAgents()).toEqual([]);
});
it('persists agents across a restart', () => {
  const root = repo(); const s = new PlanStore(root); s.init('shop-api');
  s.addAgent({ slug: 'fix-login', profile: 'backend' });
  const again = new PlanStore(root);
  expect(again.plan.name).toBe('shop-api');
  expect(again.listAgents().map((a) => [a.slug, a.profile])).toEqual([['fix-login', 'backend']]);
});
it('rejects a duplicate slug', () => {
  const root = repo(); const s = new PlanStore(root); s.init('shop-api');
  s.addAgent({ slug: 'fix-login', profile: 'backend' });
  expect(() => s.addAgent({ slug: 'fix-login', profile: 'dba' })).toThrow('slug.duplicate');
});
it('init is idempotent and keeps the original creation date', () => {
  const root = repo(); const s = new PlanStore(root); s.init('shop-api'); const created = s.plan.createdAt;
  new PlanStore(root).init('shop-api');
  expect(new PlanStore(root).plan.createdAt).toBe(created);
});

it('keeps a test command in plan.json, trims it, and clears it with an empty string', () => {
  const root = repo(); const s = new PlanStore(root); s.init('shop-api');
  expect(s.plan.testCommand).toBeUndefined();
  s.setTestCommand('  npx vitest run  ');
  expect(new PlanStore(root).plan.testCommand).toBe('npx vitest run');
  expect(new PlanStore(root).plan.name).toBe('shop-api');
  s.setTestCommand('');
  expect(new PlanStore(root).plan.testCommand).toBeUndefined();
});
it('rejects a test command that is too long or not a string', () => {
  const root = repo(); const s = new PlanStore(root); s.init('shop-api');
  expect(() => s.setTestCommand('x'.repeat(501))).toThrow('plan.testCommandInvalid');
  expect(() => s.setTestCommand(5 as unknown as string)).toThrow('plan.testCommandInvalid');
  expect(() => s.setTestCommand('a\nb')).toThrow('plan.testCommandInvalid');
});
