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
}
export interface AgentRecord { slug: string; profile: string; createdAt: string }

/** One line, at most 500 characters (the console runs it through the platform shell: the user wrote it). */
export const isValidTestCommand = (v: unknown): v is string => typeof v === 'string' && v.length <= 500 && !/[\r\n]/.test(v);

/** Plan state under <repo>/.console/ (SPEC 23): plan.json and state/agents.json. */
export class PlanStore {
  private readonly planFile: string;
  private readonly agentsFile: string;

  constructor(root: string) {
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

  addAgent(a: { slug: string; profile: string }): void {
    const all = this.listAgents();
    if (all.some((x) => x.slug === a.slug)) throw new Error('slug.duplicate');
    all.push({ ...a, createdAt: new Date().toISOString() });
    writeJsonAtomic(this.agentsFile, all);
  }
}
