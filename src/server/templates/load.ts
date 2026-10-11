import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resourcePath } from '../paths';
import { isValidProjectField, isValidTestCommand } from '../project-store';
import { SLUG_RE } from '../../shared/slug';
import { errorMessage, isObj } from '../../shared/guards';

/** Template ids are folder names: the slug rule (no separators, no traversal). */
const MAX_JSON_BYTES = 64 * 1024;

export interface TemplateData {
  schema: 1;
  id: string;
  name: Record<string, string>;
  description: Record<string, string>;
  /** Profiles offered to the new-agent picker; absent means all. */
  profiles?: string[];
  commands: { build?: string; test?: string; lint?: string; testTicket?: string; testMerge?: string; testRelease?: string };
  git: { squash?: boolean; secretPatterns?: string[] };
  /** Files the last checklist step must update. */
  docs: string[];
  defaults: { model?: string; agentTokens?: number; maxActive?: number };
  /** Read the project to propose commands (default true). */
  detect: boolean;
}

export interface TemplateEntry {
  id: string;
  source: 'shipped' | 'user';
  dir: string;
  valid: boolean;
  /** Why an invalid template is unavailable (a developer-facing sentence, shown as data). */
  reason?: string;
  data?: TemplateData;
  /** Names for the list even when the template is invalid (the id is used then). */
  name: Record<string, string>;
  description: Record<string, string>;
}

/** Where the shipped templates live: `templates/` at the repository root, next to `prompts/`. */
export const shippedTemplatesDir = (): string => resourcePath('templates');
export const userTemplatesDir = (configDir: string): string => join(configDir, 'templates');

const textMap = (v: unknown): Record<string, string> | undefined => {
  if (!isObj(v) || typeof v.en !== 'string' || v.en.trim() === '') return undefined;
  const out: Record<string, string> = {};
  for (const [lang, text] of Object.entries(v)) {
    if (typeof text !== 'string' || text.length > 500) return undefined;
    out[lang] = text;
  }
  return out;
};

/** Checks the parsed template.json; returns the data or the reason it is unusable. */
export function validateTemplate(raw: unknown, folderId: string): { ok: true; data: TemplateData } | { ok: false; reason: string } {
  if (!isObj(raw)) return { ok: false, reason: 'template.json is not an object' };
  if (raw.schema !== 1) return { ok: false, reason: 'schema must be 1' };
  if (raw.id !== folderId) return { ok: false, reason: 'id must equal the folder name' };
  const name = textMap(raw.name);
  if (!name) return { ok: false, reason: 'name needs at least an "en" text' };
  const description = textMap(raw.description);
  if (!description) return { ok: false, reason: 'description needs at least an "en" text' };
  let profiles: string[] | undefined;
  if (raw.profiles !== undefined) {
    if (!isValidProjectField('profiles', raw.profiles)) return { ok: false, reason: 'profiles must be a list of profile names' };
    profiles = raw.profiles as string[];
  }
  const commands: TemplateData['commands'] = {};
  if (raw.commands !== undefined) {
    if (!isObj(raw.commands)) return { ok: false, reason: 'commands must be an object' };
    for (const key of ['build', 'test', 'lint', 'testTicket', 'testMerge', 'testRelease'] as const) {
      const v = raw.commands[key];
      if (v === undefined) continue;
      if (!isValidTestCommand(v)) return { ok: false, reason: `commands.${key} must be one line of at most 500 characters` };
      if (v.trim() !== '') commands[key] = v.trim();
    }
  }
  const git: TemplateData['git'] = {};
  if (raw.git !== undefined) {
    if (!isObj(raw.git)) return { ok: false, reason: 'git must be an object' };
    if (raw.git.squash !== undefined) {
      if (typeof raw.git.squash !== 'boolean') return { ok: false, reason: 'git.squash must be true or false' };
      git.squash = raw.git.squash;
    }
    if (raw.git.secretPatterns !== undefined) {
      if (!isValidProjectField('secretPatterns', raw.git.secretPatterns)) return { ok: false, reason: 'git.secretPatterns must be a list of short texts' };
      git.secretPatterns = raw.git.secretPatterns as string[];
    }
  }
  let docs: string[] = [];
  if (raw.docs !== undefined) {
    if (!isValidProjectField('docs', raw.docs)) return { ok: false, reason: 'docs must be a list of at most 20 short paths' };
    docs = raw.docs as string[];
  }
  const defaults: TemplateData['defaults'] = {};
  if (raw.defaults !== undefined) {
    if (!isObj(raw.defaults)) return { ok: false, reason: 'defaults must be an object' };
    for (const key of ['model', 'agentTokens', 'maxActive'] as const) {
      const v = raw.defaults[key];
      if (v === undefined) continue;
      if (!isValidProjectField(key, v)) return { ok: false, reason: `defaults.${key} is not valid` };
      (defaults as Record<string, unknown>)[key] = v;
    }
  }
  if (raw.detect !== undefined && typeof raw.detect !== 'boolean') return { ok: false, reason: 'detect must be true or false' };
  return { ok: true, data: { schema: 1, id: folderId, name, description, ...(profiles ? { profiles } : {}), commands, git, docs, defaults, detect: raw.detect !== false } };
}

function readTemplate(dir: string, id: string, source: TemplateEntry['source']): TemplateEntry {
  const base = { id, source, dir, name: { en: id }, description: { en: '' } };
  const file = join(dir, 'template.json');
  try {
    if (!existsSync(file)) return { ...base, valid: false, reason: 'template.json is missing' };
    if (statSync(file).size > MAX_JSON_BYTES) return { ...base, valid: false, reason: 'template.json is too large' };
    const checked = validateTemplate(JSON.parse(readFileSync(file, 'utf8')) as unknown, id);
    if (!checked.ok) return { ...base, valid: false, reason: checked.reason };
    return { ...base, valid: true, data: checked.data, name: checked.data.name, description: checked.data.description };
  } catch (e) {
    return { ...base, valid: false, reason: `template.json cannot be read: ${errorMessage(e)}` };
  }
}

function scan(root: string, source: TemplateEntry['source']): TemplateEntry[] {
  if (!existsSync(root)) return [];
  const out: TemplateEntry[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SLUG_RE.test(entry.name)) continue; // anything else is not a template
    out.push(readTemplate(join(root, entry.name), entry.name, source));
  }
  return out;
}

/** Every template, shipped and the user's; on the same id the user's wins. Sorted by id. Never throws. */
export function loadTemplates(o: { configDir: string; shippedDir?: string }): TemplateEntry[] {
  const byId = new Map<string, TemplateEntry>();
  for (const t of scan(o.shippedDir ?? shippedTemplatesDir(), 'shipped')) byId.set(t.id, t);
  for (const t of scan(userTemplatesDir(o.configDir), 'user')) byId.set(t.id, t);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export const findTemplate = (id: string, o: { configDir: string; shippedDir?: string }): TemplateEntry | undefined =>
  SLUG_RE.test(id) ? loadTemplates(o).find((t) => t.id === id) : undefined;
