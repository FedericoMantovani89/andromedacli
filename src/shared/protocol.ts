/** Wire types shared by the server and the browser UI. Codes are English constants, never sentences (P11). */
import type { Activity } from './activity';
import type { NotificationsConfig, ToastStatus } from './notify';

export const PROFILES = ['backend', 'dba', 'frontend', 'reviewer', 'recovery'] as const;
export type Profile = (typeof PROFILES)[number];

/** Error codes the user can act on: each one needs an `error.<code>` text in every language (checked at build). */
export const USER_ERROR_CODES = [
  'slug.missing', 'slug.format', 'slug.length', 'slug.generic', 'slug.reserved', 'slug.duplicate',
  'profile.invalid', 'model.invalid', 'prereq.blocked', 'agent.spawnFailed',
  'git.notRepo', 'git.noCommits', 'git.worktreeExists', 'plan.testCommandInvalid', 'config.unreadable', 'review.useRequestReview', 'plan.squashInvalid', 'recovery.useRecoveryTool',
  'folder.pickBusy', 'plan.duplicate', 'plan.badRoot', 'plan.badName', 'plan.notFound', 'plan.closeFailed',
  'install.busy', 'install.unavailable',
  'agent.notDormant', 'agent.noSession', 'agent.noWorktree', 'agent.quotaHigh', 'agent.wakeFailed',
  'plan.fieldInvalid', 'plan.badRoot', 'template.notFound', 'template.invalid', 'template.exists', 'template.idInvalid',
  'git.notRepo', 'git.noCommits', 'git.worktreeExists', 'plan.testCommandInvalid', 'config.unreadable', 'config.invalid', 'review.useRequestReview', 'plan.squashInvalid', 'recovery.useRecoveryTool',
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
  /** Where the ticket is in the review/merge pipeline; absent while the author is still writing it for the first time. */
  ticket?: { status: string; round: number; maxRounds: number };
  /** The launch check found the agent not started or not working on its goal; clears when it starts working. */
  launchStalled?: true;
  /** Loop handling (Phase 5): 1 corrected, 2 limited, 3 stopped; absent when none. */
  loop?: 1 | 2 | 3;
  /** Token budget of the agent's ticket (Phase 5); absent when the agent has none (no worktree, a reviewer): shown as n/a. */
  budget?: { used: number; limit: number; step: 'ok' | 'alert' | 'limit' | 'stopped' };
  /** Phase 6A: the agent's worktree has not been touched for longer than `git.staleWorktreeDays`. */
  stale?: true;
}

export interface PrereqResult {
  id: 'node' | 'git' | 'claude' | 'gh';
  required: boolean;
  status: 'ok' | 'outdated' | 'missing' | 'error' | 'not_required';
  version?: string;
  message?: string;
}

/** A question waiting for the human (SPEC 5.6). */
export interface QueueItem {
  id: string;
  from: string;
  /** `confirm` and `decision` come from the console itself (from "console"): a release to approve, a ticket that needs the user. */
  kind: 'question' | 'permission' | 'confirm' | 'decision';
  text: string;
  /** Data of a console item (tickets, report text, review notes); shape depends on the item. */
  payload?: unknown;
  tool?: string;
  detail?: string;
  options?: string[];
  multiSelect?: boolean;
  createdAt: string;
}

export interface StateMessage {
  type: 'state';
  plan: { name: string; /** What the console runs for the validation step of every ticket. */ testCommand?: string; /** One commit per merged ticket (default true). */ squash?: boolean };
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
  /** The console is waiting for a usage limit to lift (Phase 5); absent when it is not. `until` is when the next probe is due. */
  sleep?: { until?: string; phase: 'sleeping' | 'probing' | 'awake'; attempt: number; weekly: boolean };
  /** The most used usage limit of the subscription; ABSENT when unknown (shown as n/a, never as zero). */
  quota?: { percent: number; kind: string };
  /** Agents counting against the active-agent limit, and that limit as it is now (the quota step may have cut it). */
  limits?: { active: number; max: number };
  /** Every open plan, in the order they were opened (Phase 6C): the tabs. */
  plans?: PlanTab[];
  /** The last assisted install that ended (Phase 6F); absent until one did since the console started. */
  install?: { id: string; result: 'needs_admin' | 'failed' | 'done'; exitCode: number };
  /** Phase 6B: whether a native toast can be shown (`unknown` until checked, shown as n/a) and the notification settings. */
  notifications?: { toast: ToastStatus; config: NotificationsConfig };
}

/** One tab: `waiting` is the length of that plan's queue (a dot when above zero). */
export interface PlanTab { name: string; root: string; waiting: number; mainStatus: SessionStatus }

export interface ApiError {
  code: string;
  params?: Record<string, string | number>;
}

/** Control message the browser sends as a text frame on a terminal socket; keyboard input is a binary frame. */
export interface ResizeMessage { type: 'resize'; cols: number; rows: number }

/** What the console knows about itself with or without a plan (`GET /api/host`): the welcome screen asks this first. */
export interface HostInfo {
  plans: PlanTab[];
  language: string;
  languages: string[];
  needsSetup: boolean;
}
