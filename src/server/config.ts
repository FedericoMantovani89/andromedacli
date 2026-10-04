import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic } from './fs-atomic';

/** "auto" or a language code that has a bundle (checked against the bundles by the server). */
export type Language = string;
export interface Config {
  schema: 1;
  language: Language;
  agents: { bypassPermissions: boolean };
  claude: { command: string[] };
  telemetry: false;
}
export interface ConfigError { path: string; code: 'config.invalid' | 'config.unreadable' }

export const DEFAULT_CONFIG: Config = {
  schema: 1,
  language: 'auto',
  agents: { bypassPermissions: false },
  claude: { command: ['claude'] },
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
    if (isObj(raw.agents) && 'bypassPermissions' in raw.agents) {
      if (typeof raw.agents.bypassPermissions === 'boolean') config.agents.bypassPermissions = raw.agents.bypassPermissions;
      else bad('agents.bypassPermissions');
    } else if (!isObj(raw.agents)) bad('agents');
  }
  if ('claude' in raw) {
    const cmd = isObj(raw.claude) ? raw.claude.command : undefined;
    if (Array.isArray(cmd) && cmd.length > 0 && cmd.every((c) => typeof c === 'string')) config.claude.command = cmd as string[];
    else bad('claude.command');
  }
  if ('telemetry' in raw && raw.telemetry !== false) bad('telemetry');
  return { config, errors };
}

export function saveConfigAtomic(path: string, config: Config): void {
  writeJsonAtomic(path, config);
}

/**
 * Changes only the language inside the user's file and keeps every other entry as written (even invalid or unknown ones).
 * A file that cannot be parsed is never overwritten: the caller reports `config.unreadable`.
 */
export function saveLanguage(path: string, language: Language): { ok: true } | { ok: false; code: 'config.unreadable' } {
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
  writeJsonAtomic(path, { ...raw, language });
  return { ok: true };
}
