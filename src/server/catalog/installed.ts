import { resolve } from 'node:path';
import { defaultRunner, type Runner } from '../prereq/checks';

/** One line of `claude plugin list --json`: a plugin installed in one scope (the same id can appear in several). */
export interface InstalledPlugin { id: string; version?: string; scope: string; enabled: boolean; projectPath?: string }

/**
 * Where a catalog plugin stands for the open project:
 * `installed` for every project (user scope), or `project` for this one (local or project scope), `disabled` when it is installed here but
 * switched off, `other_project` when it is only installed for other projects, `not_installed` otherwise.
 */
export type PluginInstallState = 'installed' | 'project' | 'disabled' | 'other_project' | 'not_installed';
export interface PluginStatus { state: PluginInstallState; version?: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The valid lines of the JSON the command printed; undefined when it is not a list at all (unknown is never "not installed"). */
export function parseInstalled(stdout: string): InstalledPlugin[] | undefined {
  let raw: unknown;
  try { raw = JSON.parse(stdout); } catch { return undefined; }
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((x): InstalledPlugin[] => {
    if (!isObj(x) || typeof x.id !== 'string' || typeof x.scope !== 'string') return [];
    return [{ id: x.id, scope: x.scope, enabled: x.enabled !== false, ...(typeof x.version === 'string' ? { version: x.version } : {}), ...(typeof x.projectPath === 'string' ? { projectPath: x.projectPath } : {}) }];
  });
}

const sameFolder = (a: string, b: string): boolean => (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/** The state of one plugin id for the project at `projectRoot`. */
export function statusOf(id: string, installed: readonly InstalledPlugin[], projectRoot: string): PluginStatus {
  const mine = installed.filter((p) => p.id === id);
  if (mine.length === 0) return { state: 'not_installed' };
  const here = mine.filter((p) => p.projectPath === undefined || sameFolder(p.projectPath, projectRoot)); // user-wide ones carry no folder
  if (here.length === 0) return { state: 'other_project' };
  const on = here.find((p) => p.enabled);
  const pick = on ?? here[0]!;
  if (!on) return { state: 'disabled', ...(pick.version ? { version: pick.version } : {}) };
  return { state: pick.projectPath === undefined ? 'installed' : 'project', ...(pick.version ? { version: pick.version } : {}) };
}

/**
 * Asks Claude Code itself which plugins are installed (`claude plugin list --json`): the console never looks into Claude's folders. Null
 * when the command fails or prints something else (the tab then says it cannot tell, it does not claim "not installed").
 */
export async function readInstalled(command: string[], run: Runner = defaultRunner): Promise<InstalledPlugin[] | null> {
  const [cmd, ...args] = command.length > 0 ? command : ['claude'];
  try {
    const r = await run(cmd!, [...args, 'plugin', 'list', '--json'], 20_000);
    return r.code === 0 ? (parseInstalled(r.stdout) ?? null) : null;
  } catch {
    return null;
  }
}
