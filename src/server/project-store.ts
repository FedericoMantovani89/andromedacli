import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './fs-atomic';

/** `testCommand` is what the console runs for the validation step of every ticket (SPEC 8.3); the user writes it. */
export interface PlanInfo {
  name: string;
  createdAt: string;
  testCommand?: string;
  /** One commit per ticket when merged (default); false keeps the step commits behind a merge commit (SPEC 9.7). */
  squash?: boolean;
  /** Phase 6D: what the console builds and lints with (same rules as `testCommand`). */
  buildCommand?: string;
  lintCommand?: string;
  /** Profile names offered to the new-agent picker (default: all). */
  profiles?: string[];
  /** Default model of the plan's agents (behind the request's and the profile's). */
  model?: string;
  /** Default token budget of the plan's agents (behind the request's and the profile's). */
  agentTokens?: number;
  /** Active-agent limit of this plan (default: `agents.maxActivePerPlan`). */
  maxActive?: number;
  /** Files the last checklist step must update. */
  docs?: string[];
  /** Extra secret patterns, added to the global ones. */
  secretPatterns?: string[];
}
/** What the console remembers of an agent between runs (Phase 6A). Every field after `createdAt` is optional: older files stay valid. */
export interface AgentRecord {
  slug: string; profile: string; createdAt: string;
  role?: 'main' | 'agent' | 'reviewer' | 'recovery';
  sessionId?: string;
  worktree?: string;
  branch?: string;
  /** Absolute path of the repository of the worktree (a plan folder that holds several repos); absent: the plan root. */
  repo?: string;
  model?: string;
  cwd?: string;
  /** The registry state when last seen (a crash leaves it behind: `working`/`starting` means a turn was lost). */
  lastState?: string;
  lastActiveAt?: string;
  /** The worktree has not been touched for longer than `git.staleWorktreeDays`. */
  stale?: boolean;
}
/** A patch for `updateAgent`: a key set to `undefined` is removed from the record. */
export type AgentPatch = { [K in keyof Omit<AgentRecord, 'slug' | 'createdAt'>]?: AgentRecord[K] | undefined };

/** One line, at most 500 characters (the console runs it through the platform shell: the user wrote it). */
export const isValidTestCommand = (v: unknown): v is string => typeof v === 'string' && v.length <= 500 && !/[\r\n]/.test(v);

/** A model alias or id: plain characters only, because it becomes a command-line argument (same rule as `MODEL_RE` in spawn.ts). */
const PLAN_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;
const isStringList = (v: unknown, max: number, maxLen: number): v is string[] =>
  Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.trim() !== '' && x.length <= maxLen && !/[\r\n]/.test(x));
const isIntIn = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** The optional plan fields of Phase 6D that are set through `setFields` (`testCommand` and `squash` have their own setters). */
export const PLAN_FIELDS = ['buildCommand', 'lintCommand', 'profiles', 'model', 'agentTokens', 'maxActive', 'docs', 'secretPatterns'] as const;
export type PlanField = (typeof PLAN_FIELDS)[number];

/** Whether a value is acceptable for a plan field. `knownProfiles` limits `profiles` (names the console knows). */
export function isValidPlanField(field: PlanField, v: unknown, knownProfiles: readonly string[]): boolean {
  switch (field) {
    case 'buildCommand': case 'lintCommand': return isValidTestCommand(v);
    case 'profiles': return isStringList(v, 64, 40) && v.every((p) => knownProfiles.includes(p));
    case 'model': return typeof v === 'string' && PLAN_MODEL_RE.test(v);
    case 'agentTokens': return isIntIn(v, 1000, 100_000_000);
    case 'maxActive': return isIntIn(v, 1, 64);
    case 'docs': return isStringList(v, 20, 200);
    case 'secretPatterns': return isStringList(v, 50, 200);
  }
}

/** Plan state under <repo>/.console/ (SPEC 23): plan.json and state/agents.json. */
export class PlanStore {
  private readonly planFile: string;
  private readonly agentsFile: string;
  private readonly stateDir: string;

  constructor(root: string) {
    this.stateDir = join(root, '.console', 'state');
    this.planFile = join(root, '.console', 'plan.json');
    this.agentsFile = join(root, '.console', 'state', 'agents.json');
  }

  init(name: string): void {
    if (!existsSync(this.planFile)) writeJsonAtomic(this.planFile, { name, createdAt: new Date().toISOString() });
    if (!existsSync(this.agentsFile)) writeJsonAtomic(this.agentsFile, []);
  }

  get plan(): PlanInfo {
    return JSON.parse(readFileSync(this.planFile, 'utf8')) as PlanInfo;
  }

  /** Sets (or, with an empty string, clears) the plan's test command. One line, at most 500 characters. */
  setTestCommand(command: string): void {
    if (!isValidTestCommand(command)) throw new Error('plan.testCommandInvalid');
    const { testCommand: _old, ...rest } = this.plan;
    const trimmed = command.trim();
    writeJsonAtomic(this.planFile, trimmed === '' ? rest : { ...rest, testCommand: trimmed });
  }

  setSquash(squash: boolean): void {
    if (typeof squash !== 'boolean') throw new Error('plan.squashInvalid');
    writeJsonAtomic(this.planFile, { ...this.plan, squash });
  }

  /** Stores the build and lint commands given at creation (empty or absent: left out). */
  setCommands(c: { build?: string; lint?: string }): void {
    const next: PlanInfo = { ...this.plan };
    if (c.build?.trim()) next.buildCommand = c.build.trim();
    if (c.lint?.trim()) next.lintCommand = c.lint.trim();
    writeJsonAtomic(this.planFile, next);
  }

  /**
   * Sets (or, with `undefined`, `null`, an empty string or an empty list, clears) the Phase 6D fields. Every entry is checked before
   * anything is written; a bad one throws `plan.fieldInvalid:<field>` and changes nothing.
   */
  setFields(patch: Partial<Record<PlanField, unknown>>, knownProfiles: readonly string[]): void {
    const next: Record<string, unknown> = { ...this.plan };
    for (const field of PLAN_FIELDS) {
      if (!(field in patch)) continue;
      let v = patch[field];
      if (typeof v === 'string') v = v.trim();
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) { delete next[field]; continue; }
      if (!isValidPlanField(field, v, knownProfiles)) throw new Error(`plan.fieldInvalid:${field}`);
      next[field] = v;
    }
    writeJsonAtomic(this.planFile, next);
  }

  /** The plan's optional fields; empty when plan.json cannot be read (a damaged file must not stop a launch). */
  fields(): Partial<PlanInfo> {
    try { return this.plan; } catch { return {}; }
  }

  listAgents(): AgentRecord[] {
    if (!existsSync(this.agentsFile)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.agentsFile, 'utf8'));
      return Array.isArray(parsed) ? (parsed as AgentRecord[]) : []; // a damaged file must not take the console down
    } catch {
      return [];
    }
  }

  /** Forgets an agent whose creation failed (a normal agent stays on record: the name stays reserved). */
  removeAgent(slug: string): void {
    writeJsonAtomic(this.agentsFile, this.listAgents().filter((a) => a.slug !== slug));
  }

  addAgent(a: { slug: string; profile: string; model?: string }): void {
    const all = this.listAgents();
    if (all.some((x) => x.slug === a.slug)) throw new Error('slug.duplicate');
    all.push({ ...a, createdAt: new Date().toISOString() });
    writeJsonAtomic(this.agentsFile, all);
  }

  /** Merges a patch into one agent's record (atomic write). An unknown slug is ignored. */
  updateAgent(slug: string, patch: AgentPatch): void {
    const all = this.listAgents();
    const i = all.findIndex((a) => a.slug === slug);
    if (i < 0) return;
    const next: Record<string, unknown> = { ...all[i] };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    all[i] = next as unknown as AgentRecord;
    writeJsonAtomic(this.agentsFile, all);
  }

  private readJson(name: string): Record<string, unknown> | undefined {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(this.stateDir, name), 'utf8'));
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined; // missing or damaged: treated as no saved state
    }
  }

  /** The main's last session id (`state/main.json`), kept so a restart resumes its context. */
  readMainSession(): string | undefined {
    const id = this.readJson('main.json')?.sessionId;
    return typeof id === 'string' ? id : undefined;
  }

  writeMainSession(sessionId: string): void {
    writeJsonAtomic(join(this.stateDir, 'main.json'), { sessionId });
  }

  /** `state/run.json`: false after a crash (the previous run never reached the end of `close()`); true when there is no file. */
  readCleanStop(): boolean {
    return this.readJson('run.json')?.cleanStop !== false;
  }

  writeCleanStop(cleanStop: boolean): void {
    writeJsonAtomic(join(this.stateDir, 'run.json'), { cleanStop });
  }
}
