/** Wire types shared by the server and the browser UI. Codes are English constants, never sentences (P11). */
import type { Activity } from './activity';

export const PROFILES = ['backend', 'dba', 'frontend', 'reviewer', 'recovery'] as const;
export type Profile = (typeof PROFILES)[number];

/** Error codes the user can act on: each one needs an `error.<code>` text in every language (checked at build). */
export const USER_ERROR_CODES = [
  'slug.missing', 'slug.format', 'slug.length', 'slug.generic', 'slug.reserved', 'slug.duplicate',
  'profile.invalid', 'model.invalid', 'prereq.blocked', 'agent.spawnFailed',
  'git.notRepo', 'git.noCommits', 'git.worktreeExists', 'plan.testCommandInvalid', 'config.unreadable',
] as const;

/** `pending`: no process yet (the agent waits in the queue for a free slot). */
export type SessionStatus = 'running' | 'exited' | 'pending';

export interface SessionInfo {
  slug: string;
  profile: string;
  role: 'main' | 'agent';
  /** Process status (is the process alive). */
  status: SessionStatus;
  /** What the session is doing, from mod events (plus `studying`/`blocked`, derived from the ticket). */
  state: Activity;
  /** Closed steps of the agent's checklist; absent until it has one. */
  progress?: { done: number; total: number };
  /** The launch check found the agent not started or not working on its goal; clears when it starts working. */
  launchStalled?: true;
}

export interface PrereqResult {
  id: 'node' | 'git' | 'claude';
  required: boolean;
  status: 'ok' | 'outdated' | 'missing' | 'error' | 'not_required';
  version?: string;
  message?: string;
}

/** A question waiting for the human (SPEC 5.6). */
export interface QueueItem {
  id: string;
  from: string;
  kind: 'question' | 'permission';
  text: string;
  tool?: string;
  detail?: string;
  options?: string[];
  multiSelect?: boolean;
  createdAt: string;
}

export interface StateMessage {
  type: 'state';
  plan: { name: string; /** What the console runs for the validation step of every ticket. */ testCommand?: string };
  /** What the Settings dialog shows; a change applies to sessions launched afterwards. */
  settings: { bypassPermissions: boolean; guardMode: 'enforce' | 'shadow'; worktrees: boolean };
  main: SessionInfo;
  agents: SessionInfo[];
  language: string;
  /** Every language that has a bundle file (a new language is just a new file, SPEC 5.9). */
  languages: string[];
  profiles: readonly string[];
  /** null until the startup checks finish (unknown is not "ok", P7). */
  prereq: PrereqResult[] | null;
  /** true until the first-start wizard saved a configuration file. */
  needsSetup: boolean;
  planIsRepo: boolean;
  planRoot: string;
  /** Everything that waits for the user: questions from the main and the agents. */
  queue: QueueItem[];
}

export interface ApiError {
  code: string;
  params?: Record<string, string | number>;
}

/** Control message the browser sends as a text frame on a terminal socket; keyboard input is a binary frame. */
export interface ResizeMessage { type: 'resize'; cols: number; rows: number }
