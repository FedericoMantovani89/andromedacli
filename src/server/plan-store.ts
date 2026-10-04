import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './fs-atomic';

export interface PlanInfo { name: string; createdAt: string }
export interface AgentRecord { slug: string; profile: string; createdAt: string }

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

  listAgents(): AgentRecord[] {
    if (!existsSync(this.agentsFile)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.agentsFile, 'utf8'));
      return Array.isArray(parsed) ? (parsed as AgentRecord[]) : []; // a damaged file must not take the console down
    } catch {
      return [];
    }
  }

  addAgent(a: { slug: string; profile: string }): void {
    const all = this.listAgents();
    if (all.some((x) => x.slug === a.slug)) throw new Error('slug.duplicate');
    all.push({ ...a, createdAt: new Date().toISOString() });
    writeJsonAtomic(this.agentsFile, all);
  }
}
