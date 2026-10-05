import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic } from './fs-atomic';
import { DEFAULT_SECRET_PATTERNS } from './git/secrets';

/** "auto" or a language code that has a bundle (checked against the bundles by the server). */
export type Language = string;
export interface Config {
  schema: 1;
  language: Language;
  agents: { bypassPermissions: boolean; maxActiveGlobal: number; maxActivePerPlan: number };
  claude: { command: string[] };
  mod: { enabled: boolean };
  /** Worktrees and commits by the console (SPEC 9). `worktrees: false` keeps the Phase 2 behaviour: agents share the plan folder. */
  git: { worktrees: boolean; secretPatterns: string[]; testTimeoutMinutes: number };
  /** `shadow` allows everything but logs what `enforce` would have denied (SPEC 14). */
  guard: { mode: 'enforce' | 'shadow' };
  /** Budget, loop and quota thresholds (SPEC 16, 17, 18). Applied to sessions launched afterwards; the quota steps are read on every event. */
  budget: BudgetConfig;
  telemetry: false;
}
export interface BudgetConfig {
  agentTokens: number; alertPercent: number; limitPercent: number; stopPercent: number; graceMinutes: number;
  loop: { sameCall: number; sameError: number; compactions: number; stepMinutes: number; silenceMinutes: number };
  quota: { halvePercent: number; freezePercent: number; stopPercent: number; staggerSeconds: number; staggerGroup: number };
}
export interface ConfigError { path: string; code: 'config.invalid' | 'config.unreadable' }

export const DEFAULT_CONFIG: Config = {
  schema: 1,
  language: 'auto',
  agents: { bypassPermissions: false, maxActiveGlobal: 4, maxActivePerPlan: 3 },
  claude: { command: ['claude'] },
  mod: { enabled: true },
  git: { worktrees: true, secretPatterns: DEFAULT_SECRET_PATTERNS, testTimeoutMinutes: 15 },
  guard: { mode: 'enforce' },
  budget: {
    agentTokens: 400000, alertPercent: 80, limitPercent: 100, stopPercent: 110, graceMinutes: 5,
    loop: { sameCall: 5, sameError: 3, compactions: 2, stepMinutes: 30, silenceMinutes: 5 },
    quota: { halvePercent: 70, freezePercent: 85, stopPercent: 95, staggerSeconds: 60, staggerGroup: 2 },
  },
  telemetry: false,
};

/** %APPDATA%/console, or CONSOLE_CONFIG_DIR when set (tests, portable installs). */
export const configDir = (): string =>
  process.env.CONSOLE_CONFIG_DIR ?? join(process.env.APPDATA ?? homedir(), 'console');

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** SPEC 29.7: an invalid entry never blocks the console; the default is used and the error is reported. */
export function loadConfig(path: string): { config: Config; errors: ConfigError[] } {
  const config: Config = structuredClone(DEFAULT_CONFIG);
  const errors: ConfigError[] = [];
  if (!existsSync(path)) return { config, errors };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { config, errors: [{ path: '', code: 'config.unreadable' }] };
  }
  if (!isObj(raw)) return { config, errors: [{ path: '', code: 'config.unreadable' }] };
  const bad = (p: string) => errors.push({ path: p, code: 'config.invalid' });

  if ('language' in raw) {
    if (typeof raw.language === 'string' && /^(auto|[a-z]{2,3})$/.test(raw.language)) config.language = raw.language;
    else bad('language');
  }
  if ('agents' in raw) {
    if (isObj(raw.agents)) {
      const a = raw.agents;
      if ('bypassPermissions' in a) {
        if (typeof a.bypassPermissions === 'boolean') config.agents.bypassPermissions = a.bypassPermissions;
        else bad('agents.bypassPermissions');
      }
      for (const key of ['maxActiveGlobal', 'maxActivePerPlan'] as const) {
        if (!(key in a)) continue;
        const v = a[key];
        if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 64) config.agents[key] = v;
        else bad(`agents.${key}`);
      }
    } else bad('agents');
  }
  if ('claude' in raw) {
    const cmd = isObj(raw.claude) ? raw.claude.command : undefined;
    if (Array.isArray(cmd) && cmd.length > 0 && cmd.every((c) => typeof c === 'string')) config.claude.command = cmd as string[];
    else bad('claude.command');
  }
  if ('mod' in raw) {
    const enabled = isObj(raw.mod) ? raw.mod.enabled : undefined;
    if (typeof enabled === 'boolean') config.mod.enabled = enabled;
    else bad('mod.enabled');
  }
  if ('git' in raw) {
    if (isObj(raw.git)) {
      const g = raw.git;
      if ('worktrees' in g) {
        if (typeof g.worktrees === 'boolean') config.git.worktrees = g.worktrees;
        else bad('git.worktrees');
      }
      if ('secretPatterns' in g) {
        const sp = g.secretPatterns;
        if (Array.isArray(sp) && sp.every((x) => typeof x === 'string' && x.trim() !== '' && x.length <= 200)) config.git.secretPatterns = sp as string[];
        else bad('git.secretPatterns');
      }
      if ('testTimeoutMinutes' in g) {
        const v = g.testTimeoutMinutes;
        if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 240) config.git.testTimeoutMinutes = v;
        else bad('git.testTimeoutMinutes');
      }
    } else bad('git');
  }
  if ('guard' in raw) {
    const mode = isObj(raw.guard) ? raw.guard.mode : undefined;
    if (mode === 'enforce' || mode === 'shadow') config.guard.mode = mode;
    else bad('guard.mode');
  }
  if ('budget' in raw) {
    if (isObj(raw.budget)) {
      const b = raw.budget;
      const int = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
      const set = (path: string, v: unknown, lo: number, hi: number, apply: (n: number) => void): void => { if (v === undefined) return; if (int(v, lo, hi)) apply(v); else bad(path); };
      const c = config.budget;
      set('budget.agentTokens', b.agentTokens, 1000, 100_000_000, (n) => { c.agentTokens = n; });
      set('budget.graceMinutes', b.graceMinutes, 0, 120, (n) => { c.graceMinutes = n; });
      // alert < limit <= stop: an invalid trio keeps all three defaults and is reported on every given entry
      const trio = { alertPercent: b.alertPercent ?? c.alertPercent, limitPercent: b.limitPercent ?? c.limitPercent, stopPercent: b.stopPercent ?? c.stopPercent };
      const okTrio = int(trio.alertPercent, 1, 200) && int(trio.limitPercent, 1, 200) && int(trio.stopPercent, 1, 200) && trio.alertPercent < trio.limitPercent && trio.limitPercent <= trio.stopPercent;
      for (const key of ['alertPercent', 'limitPercent', 'stopPercent'] as const) {
        if (b[key] === undefined) continue;
        if (okTrio) c[key] = trio[key] as number; else bad(`budget.${key}`);
      }
      if (isObj(b.loop)) {
        for (const [key, lo, hi] of [['sameCall', 1, 1000], ['sameError', 1, 1000], ['compactions', 1, 1000], ['stepMinutes', 1, 1000], ['silenceMinutes', 1, 1000]] as const) {
          set(`budget.loop.${key}`, (b.loop as Record<string, unknown>)[key], lo, hi, (n) => { c.loop[key] = n; });
        }
      } else if ('loop' in b) bad('budget.loop');
      if (isObj(b.quota)) {
        const q = b.quota as Record<string, unknown>;
        const trioQ = { halvePercent: q.halvePercent ?? c.quota.halvePercent, freezePercent: q.freezePercent ?? c.quota.freezePercent, stopPercent: q.stopPercent ?? c.quota.stopPercent };
        const okQ = int(trioQ.halvePercent, 1, 100) && int(trioQ.freezePercent, 1, 100) && int(trioQ.stopPercent, 1, 100) && trioQ.halvePercent < trioQ.freezePercent && trioQ.freezePercent < trioQ.stopPercent;
        for (const key of ['halvePercent', 'freezePercent', 'stopPercent'] as const) {
          if (q[key] === undefined) continue;
          if (okQ) c.quota[key] = trioQ[key] as number; else bad(`budget.quota.${key}`);
        }
        set('budget.quota.staggerSeconds', q.staggerSeconds, 0, 3600, (n) => { c.quota.staggerSeconds = n; });
        set('budget.quota.staggerGroup', q.staggerGroup, 1, 16, (n) => { c.quota.staggerGroup = n; });
      } else if ('quota' in b) bad('budget.quota');
    } else bad('budget');
  }
  if ('telemetry' in raw && raw.telemetry !== false) bad('telemetry');
  return { config, errors };
}

export function saveConfigAtomic(path: string, config: Config): void {
  writeJsonAtomic(path, config);
}

/**
 * Changes only the given entries (language, the bypass switch, the guard mode) inside the user's file and keeps every other entry as written (even invalid or unknown ones).
 * A file that cannot be parsed is never overwritten: the caller reports `config.unreadable`.
 */
export interface ConfigPatch {
  language?: Language;
  agents?: { bypassPermissions: boolean };
  guard?: { mode: 'enforce' | 'shadow' };
}

export function patchConfig(path: string, patch: ConfigPatch): { ok: true } | { ok: false; code: 'config.unreadable' } {
  let raw: Record<string, unknown> = { schema: 1 };
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!isObj(parsed)) return { ok: false, code: 'config.unreadable' };
      raw = parsed;
    } catch {
      return { ok: false, code: 'config.unreadable' };
    }
  }
  const next: Record<string, unknown> = { ...raw };
  if (patch.language !== undefined) next.language = patch.language;
  if (patch.agents) next.agents = { ...(isObj(raw.agents) ? raw.agents : {}), ...patch.agents };
  if (patch.guard) next.guard = { ...(isObj(raw.guard) ? raw.guard : {}), ...patch.guard };
  writeJsonAtomic(path, next);
  return { ok: true };
}

export const saveLanguage = (path: string, language: Language): ReturnType<typeof patchConfig> => patchConfig(path, { language });
