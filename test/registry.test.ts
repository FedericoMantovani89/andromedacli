import { it, expect, vi } from 'vitest';
import { AgentRegistry } from '../src/server/agents/registry';

const ev = (type: 'session.start' | 'session.end' | 'turn.start' | 'turn.complete', sessionId = 's1') => ({ type, sessionId });
const agent = (r: AgentRegistry, slug = 'fix-login', extra: Record<string, unknown> = {}) =>
  r.register({ slug, role: 'agent', profile: 'backend', goal: 'do it', ...extra });

it('a queued request is "queued", a spawned process is "starting"', () => {
  const r = new AgentRegistry();
  agent(r, 'a-job', { queued: true });
  expect(r.get('a-job')?.state).toBe('queued');
  r.onSpawned('a-job');
  expect(r.get('a-job')?.state).toBe('starting');
});
it('follows the events: session.start -> idle -> working -> idle', () => {
  const r = new AgentRegistry();
  agent(r); r.onSpawned('fix-login');
  r.onModEvent('fix-login', ev('session.start'));
  expect(r.get('fix-login')).toMatchObject({ state: 'idle', sessionId: 's1' });
  r.onModEvent('fix-login', ev('turn.start'));
  expect(r.get('fix-login')?.state).toBe('working');
  r.onModEvent('fix-login', ev('turn.complete'));
  expect(r.get('fix-login')?.state).toBe('idle');
});
it('waiting_user and back to working', () => {
  const r = new AgentRegistry();
  agent(r); r.onSpawned('fix-login'); r.onModEvent('fix-login', ev('turn.start'));
  r.setWaitingUser('fix-login', true);
  expect(r.get('fix-login')?.state).toBe('waiting_user');
  r.setWaitingUser('fix-login', false);
  expect(r.get('fix-login')?.state).toBe('working');
});
it('a process exit makes any agent "interrupted", and later events do not resurrect it', () => {
  const r = new AgentRegistry();
  agent(r); r.onSpawned('fix-login'); r.onModEvent('fix-login', ev('turn.start'));
  r.onProcessExit('fix-login');
  expect(r.get('fix-login')?.state).toBe('interrupted');
  r.onModEvent('fix-login', ev('turn.complete'));
  expect(r.get('fix-login')?.state).toBe('interrupted');
});
it('ignores events for an unknown slug', () => {
  const r = new AgentRegistry();
  expect(() => r.onModEvent('ghost-job', ev('turn.start'))).not.toThrow();
  expect(r.get('ghost-job')).toBeUndefined();
});
it('counts as active: starting, working, and idle with the first goal still pending; never the main', () => {
  const r = new AgentRegistry();
  agent(r); r.onSpawned('fix-login');
  expect(r.isActive('fix-login')).toBe(true);                 // starting
  r.onModEvent('fix-login', ev('session.start'));
  expect(r.isActive('fix-login')).toBe(true);                 // idle but goal pending
  r.onModEvent('fix-login', ev('turn.start'));
  r.goalDelivered('fix-login');
  expect(r.isActive('fix-login')).toBe(true);                 // working
  r.onModEvent('fix-login', ev('turn.complete'));
  expect(r.isActive('fix-login')).toBe(false);                // idle, goal done
  r.onModEvent('fix-login', ev('turn.start')); r.setWaitingUser('fix-login', true);
  expect(r.isActive('fix-login')).toBe(false);                // waiting_user
  r.onProcessExit('fix-login');
  expect(r.isActive('fix-login')).toBe(false);                // interrupted
  r.register({ slug: 'shop-api', role: 'main', profile: 'main' }); r.onSpawned('shop-api');
  expect(r.isActive('shop-api')).toBe(false);
  agent(r, 'q-job', { queued: true });
  expect(r.isActive('q-job')).toBe(false);                    // queued
});
it('notifies listeners on changes and not on a repeated no-op', () => {
  const r = new AgentRegistry(); const cb = vi.fn(); r.on(cb);
  agent(r); r.onSpawned('fix-login');
  const before = cb.mock.calls.length;
  r.onModEvent('fix-login', ev('turn.start'));
  r.onModEvent('fix-login', ev('turn.start'));
  expect(cb.mock.calls.length).toBe(before + 1);
});

it('a session finished on purpose ends as "finished", not "interrupted", and no longer counts as active', () => {
  const r = new AgentRegistry();
  r.register({ slug: 'fix-login', role: 'agent', profile: 'backend', goal: 'g' });
  r.onSpawned('fix-login');
  r.onModEvent('fix-login', { type: 'session.start', sessionId: 's' });
  r.onModEvent('fix-login', { type: 'turn.start', sessionId: 's' });
  r.onModEvent('fix-login', { type: 'turn.complete', sessionId: 's' });
  r.markFinished('fix-login');
  expect(r.get('fix-login')!.state).toBe('idle'); // the process has not exited yet
  r.onProcessExit('fix-login');
  expect(r.get('fix-login')!.state).toBe('finished');
  expect(r.isActive('fix-login')).toBe(false);
  r.onModEvent('fix-login', { type: 'turn.start', sessionId: 's' }); // a late event does not bring it back
  expect(r.get('fix-login')!.state).toBe('finished');
});
it('a session that dies without being finished is still "interrupted"', () => {
  const r = new AgentRegistry();
  r.register({ slug: 'fix-login', role: 'agent', profile: 'backend' });
  r.onSpawned('fix-login');
  r.onProcessExit('fix-login');
  expect(r.get('fix-login')!.state).toBe('interrupted');
});
it('roles include reviewer, the read-only flag is kept, and a reviewer counts as active', () => {
  const r = new AgentRegistry();
  r.register({ slug: 'review-x', role: 'reviewer', profile: 'reviewer', readOnly: true });
  expect(r.get('review-x')).toMatchObject({ role: 'reviewer', readOnly: true });
  expect(r.isActive('review-x')).toBe(true); // a reviewer counts against the active-agent limit like any agent
});
it('setCwd and session.start store the folder; a recovery agent counts as active', () => {
  const r = new AgentRegistry();
  r.register({ slug: 'rec-x', role: 'recovery', profile: 'recovery', goal: 'diagnose' });
  r.setCwd('rec-x', '/w/one');
  expect(r.get('rec-x')!.cwd).toBe('/w/one');
  r.onModEvent('rec-x', { type: 'session.start', sessionId: 's', data: { cwd: '/w/two' } });
  expect(r.get('rec-x')!.cwd).toBe('/w/two');
  expect(r.isActive('rec-x')).toBe(true);
});

it('the git info of an agent can carry its repository', () => {
  const r = new AgentRegistry();
  agent(r, 'a-job');
  r.setGit('a-job', { worktree: 'W', branch: 'B', repo: 'R' });
  expect(r.get('a-job')?.git).toEqual({ worktree: 'W', branch: 'B', repo: 'R' });
});
