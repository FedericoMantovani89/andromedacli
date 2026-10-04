/**
 * What an agent is doing, derived from mod events (never from the terminal). SPEC 6.3 plus `idle` (the "libero" of 13.2).
 * `finished`: the session ended on purpose (its ticket was merged, or its review is done); it is not a failure.
 * `studying` and `blocked` are derived by the state builder from the ticket (no checklist yet / a reported block); the
 * registry itself never holds them.
 */
export type Activity = 'starting' | 'idle' | 'working' | 'waiting_user' | 'queued' | 'interrupted' | 'studying' | 'blocked' | 'finished';

export const ACTIVITIES: readonly Activity[] = ['starting', 'idle', 'working', 'waiting_user', 'queued', 'interrupted', 'studying', 'blocked', 'finished'];

export interface ModEvent {
  type: 'session.start' | 'session.end' | 'turn.start' | 'turn.complete';
  sessionId: string;
  data?: Record<string, unknown>;
}
