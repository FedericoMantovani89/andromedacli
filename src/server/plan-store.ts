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
  /** Commands the user gave when the plan was created (Phase 6C); only stored here, `testCommand` is the one the console runs. */
  buildCommand?: string;
  lintCommand?: string;
}
/** What the console remembers of an agent between runs (Phase 6A). Every field after `createdAt` is optional: older files stay valid. */
export interface AgentRecord {
  slug: string; profile: string; createdAt: string;
  role?: 'main' | 'agent' | 'reviewer' | 'recovery';
  sessionId?: string;
  worktree?: string;
  branch?: string;
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
