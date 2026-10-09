import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRegistry } from '../src/server/agents/registry';
import { LaunchWatch } from '../src/server/agents/launch-watch';

let registry: AgentRegistry;
let sent: string[];
let watch: LaunchWatch;

beforeEach(() => {
  vi.useFakeTimers();
  registry = new AgentRegistry();
  sent = [];
  watch = new LaunchWatch({ registry, delayMs: () => 90_000, notifyMain: (text) => { sent.push(text); } });
});
afterEach(() => { watch.close(); vi.useRealTimers(); });

const launch = (slug: string, goal = 'do it'): void => {
  registry.register({ slug, role: 'agent', profile: 'developer', goal });
  registry.onSpawned(slug);
  watch.watch(slug);
};
const start = (slug: string): void => registry.onModEvent(slug, { type: 'session.start', sessionId: 's' });
const work = (slug: string): void => registry.onModEvent(slug, { type: 'turn.start', sessionId: 's' });

describe('LaunchWatch', () => {
  it('says why an agent is flagged: no_session, then goal_not_taken, and nothing once it works', async () => {
    launch('fix-login');
    expect(watch.reason('fix-login')).toBeUndefined(); // not reported yet
    await vi.advanceTimersByTimeAsync(90_000);
    expect(watch.reason('fix-login')).toBe('no_session');
    start('fix-login');
    expect(watch.reason('fix-login')).toBe('goal_not_taken');
    work('fix-login');
    expect(watch.reason('fix-login')).toBeUndefined();
    expect(watch.stalled('fix-login')).toBe(false);
  });
  it('stays silent when the agent started and took its goal in time', async () => {
    launch('fix-login');
    start('fix-login');
    work('fix-login');
    await vi.advanceTimersByTimeAsync(90_000);
    expect(sent).toEqual([]);
    expect(watch.stalled('fix-login')).toBe(false);
  });
  it('tells the main once when the agent never reported in (no session.start)', async () => {
    launch('fix-login');
    await vi.advanceTimersByTimeAsync(89_000);
    expect(sent).toEqual([]); // not yet
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('fix-login');
    expect(sent[0]).toMatch(/has not started/i);
    expect(watch.stalled('fix-login')).toBe(true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent).toHaveLength(1); // one report per agent
  });
  it('tells the main when the agent started but did not take its goal', async () => {
    launch('fix-login');
    start('fix-login');
    await vi.advanceTimersByTimeAsync(90_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/has not taken its goal/i);
    expect(watch.stalled('fix-login')).toBe(true);
  });
  it('tells the main when the process ended before doing anything', async () => {
    launch('fix-login');
    registry.onProcessExit('fix-login');
    await vi.advanceTimersByTimeAsync(90_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/ended/i);
  });
  it('a late start clears the stalled flag', async () => {
    launch('fix-login');
    await vi.advanceTimersByTimeAsync(90_000);
    expect(watch.stalled('fix-login')).toBe(true);
    start('fix-login');
    work('fix-login');
    expect(watch.stalled('fix-login')).toBe(false);
  });
  it('an agent with no goal only needs to report in', async () => {
    launch('fix-login', '');
    start('fix-login');
    await vi.advanceTimersByTimeAsync(90_000);
    expect(sent).toEqual([]);
  });
  it('each agent has its own clock and its own message', async () => {
    launch('first-job');
    await vi.advanceTimersByTimeAsync(30_000);
    launch('second-job');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('first-job');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('second-job');
  });
  it('close() cancels pending checks (shutdown must not produce messages)', async () => {
    launch('fix-login');
    watch.close();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(sent).toEqual([]);
  });
  it('watching an agent that is not registered does nothing', async () => {
    watch.watch('ghost');
    await vi.advanceTimersByTimeAsync(200_000);
    expect(sent).toEqual([]);
  });
  it('a change of delay applies to the checks started afterwards', async () => {
    let delay = 90_000;
    const w = new LaunchWatch({ registry, delayMs: () => delay, notifyMain: (t) => { sent.push(t); } });
    registry.register({ slug: 'a-job', role: 'agent', profile: 'developer', goal: 'g' });
    registry.onSpawned('a-job');
    delay = 10_000;
    w.watch('a-job');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toHaveLength(1);
    w.close();
  });
});
