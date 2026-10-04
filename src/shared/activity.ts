/** What an agent is doing, derived from mod events (never from the terminal). SPEC 6.3 plus `idle` (the "libero" of 13.2). */
export type Activity = 'starting' | 'idle' | 'working' | 'waiting_user' | 'queued' | 'interrupted';

export const ACTIVITIES: readonly Activity[] = ['starting', 'idle', 'working', 'waiting_user', 'queued', 'interrupted'];

export interface ModEvent {
  type: 'session.start' | 'session.end' | 'turn.start' | 'turn.complete';
  sessionId: string;
  data?: Record<string, unknown>;
}
