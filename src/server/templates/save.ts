import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../fs-atomic';
import type { ProjectInfo } from '../project-store';
import { userTemplatesDir, type TemplateData } from './load';
import { PROFILE_FILE_RE, SLUG_RE } from '../../shared/slug';

export type SaveResult = { ok: true; dir: string } | { ok: false; code: 'template.idInvalid' | 'template.exists' | 'template.invalid'; detail?: string };

const MAX_ID = 40;

/**
 * "Save project as template" (SPEC 21): a COPY of what the project has (its profiles, main.md, rules.md and the settings in project.json)
 * in the user's templates folder. Later changes to the project never touch it. An existing template of the user's is refused unless
 * `overwrite` is set.
 */
export function saveTemplate(o: {
  projectRoot: string; project: ProjectInfo; configDir: string; id: string; name?: unknown; overwrite?: boolean;
}): SaveResult {
  if (typeof o.id !== 'string' || o.id.length > MAX_ID || !SLUG_RE.test(o.id)) return { ok: false, code: 'template.idInvalid' };
  const name = nameMap(o.name, o.id);
  if (!name) return { ok: false, code: 'template.invalid', detail: 'name' };
  const dir = join(userTemplatesDir(o.configDir), o.id);
  if (existsSync(dir) && o.overwrite !== true) return { ok: false, code: 'template.exists' };

  const p = o.project;
  const data: TemplateData = {
    schema: 1,
    id: o.id,
    name,
    description: { en: `Saved from the project ${p.name}`, it: `Salvato dal progetto ${p.name}` },
    ...(p.profiles ? { profiles: p.profiles } : {}),
    commands: {
      ...(p.buildCommand ? { build: p.buildCommand } : {}),
      ...(p.testCommand ? { test: p.testCommand } : {}),
      ...(p.lintCommand ? { lint: p.lintCommand } : {}),
    },
    git: { ...(p.squash !== undefined ? { squash: p.squash } : {}), ...(p.secretPatterns ? { secretPatterns: p.secretPatterns } : {}) },
    docs: p.docs ?? [],
    defaults: { ...(p.model ? { model: p.model } : {}), ...(p.agentTokens !== undefined ? { agentTokens: p.agentTokens } : {}), ...(p.maxActive !== undefined ? { maxActive: p.maxActive } : {}) },
    detect: false, // a copy of a working project keeps its commands as they are
  };

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(join(dir, 'template.json'), data);
  const consoleDir = join(o.projectRoot, '.andromedacli');
  for (const f of ['main.md', 'rules.md']) if (existsSync(join(consoleDir, f))) copyFileSync(join(consoleDir, f), join(dir, f));
  const profiles = join(consoleDir, 'profiles');
  if (existsSync(profiles)) {
    mkdirSync(join(dir, 'profiles'), { recursive: true });
    for (const f of readdirSync(profiles)) if (PROFILE_FILE_RE.test(f)) copyFileSync(join(profiles, f), join(dir, 'profiles', f));
  }
  return { ok: true, dir };
}

/** A plain string names every language alike; an object must carry at least `en`; nothing given uses the id. */
function nameMap(raw: unknown, id: string): Record<string, string> | undefined {
  if (raw === undefined || raw === null || raw === '') return { en: id, it: id };
  if (typeof raw === 'string') return raw.length <= 100 && !/[\r\n]/.test(raw) ? { en: raw, it: raw } : undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [lang, text] of Object.entries(raw)) {
    if (typeof text !== 'string' || text.length > 100 || /[\r\n]/.test(text)) return undefined;
    out[lang] = text;
  }
  return typeof out.en === 'string' && out.en.trim() !== '' ? out : undefined;
}
