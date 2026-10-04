import { it, expect } from 'vitest';
import { runningAgents } from '../src/shared/stats';

const s = (slug: string, role: 'main' | 'agent', status: 'running' | 'exited') => ({ slug, profile: 'x', role, status });
it('counts only running agents, never the main session', () => {
  expect(runningAgents(s('m', 'main', 'running'), [s('a', 'agent', 'running'), s('b', 'agent', 'running'), s('c', 'agent', 'exited')])).toBe(2);
});
it('is zero when only the main runs', () => {
  expect(runningAgents(s('m', 'main', 'running'), [])).toBe(0);
});
