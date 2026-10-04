/** Wire types shared by the server and the browser UI. Codes are English constants, never sentences (P11). */
export const PROFILES = ['backend', 'dba', 'frontend', 'reviewer', 'recovery'] as const;
export type Profile = (typeof PROFILES)[number];

/** Error codes the user can act on: each one needs an `error.<code>` text in every language (checked at build). */
export const USER_ERROR_CODES = [
  'slug.missing', 'slug.format', 'slug.length', 'slug.generic', 'slug.reserved', 'slug.duplicate',
  'profile.invalid', 'prereq.blocked', 'agent.spawnFailed',
] as const;

export type SessionStatus = 'running' | 'exited';

export interface SessionInfo {
  slug: string;
  profile: string;
  role: 'main' | 'agent';
  status: SessionStatus;
}

export interface PrereqResult {
  id: 'node' | 'git' | 'claude';
  required: boolean;
  status: 'ok' | 'outdated' | 'missing' | 'error' | 'not_required';
  version?: string;
  message?: string;
}

export interface StateMessage {
  type: 'state';
  plan: { name: string };
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
}

export interface ApiError {
  code: string;
  params?: Record<string, string | number>;
}

/** Control message the browser sends as a text frame on a terminal socket; keyboard input is a binary frame. */
export interface ResizeMessage { type: 'resize'; cols: number; rows: number }
