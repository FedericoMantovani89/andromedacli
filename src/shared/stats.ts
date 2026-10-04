import type { SessionInfo } from './protocol';

/** Agents currently running; the main session is not an agent (SPEC 5.7: "agenti 3/4"). */
export function runningAgents(_main: SessionInfo, agents: SessionInfo[]): number {
  return agents.filter((a) => a.status === 'running').length;
}
