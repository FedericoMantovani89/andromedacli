import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configDir } from './config';

export interface Profile {
  name: string;
  description: string;
  model?: string;
  /** The text added to the system prompt (frontmatter removed; `console:` keys are the console's, not Claude's). */
  body: string;
  source: 'plan' | 'user' | 'shipped';
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const promptsDir = (): string => resolve(import.meta.dirname, '..', '..', 'prompts');

/** Frontmatter subset: top-level `key: value` lines; nested blocks (like `console:`) are skipped. */
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { meta: {}, body: normalized.trim() };
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return { meta: {}, body: normalized.trim() };
  const meta: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split('\n')) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line); // indented lines do not match: they belong to a nested block
    if (m && m[2] !== '') meta[m[1]!] = m[2]!.trim();
  }
  return { meta, body: normalized.slice(end + 4).replace(/^\n+/, '').trim() };
}

function readProfile(file: string, name: string, source: Profile['source']): Profile | undefined {
  if (!existsSync(file)) return undefined;
  const { meta, body } = parseFrontmatter(readFileSync(file, 'utf8'));
  const model = meta.model && meta.model !== 'default' && /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/.test(meta.model) ? meta.model : undefined;
  return { name, description: meta.description ?? '', model, body, source };
}

/** SPEC 11.4: the plan's profiles override the user's, which override the shipped ones. */
export function loadProfile(name: string, planRoot: string, userDir: string = join(configDir(), 'profiles')): Profile | undefined {
  if (!NAME_RE.test(name)) return undefined; // also rules out path traversal
  return readProfile(join(planRoot, '.console', 'profiles', `${name}.md`), name, 'plan')
    ?? readProfile(join(userDir, `${name}.md`), name, 'user')
    ?? readProfile(join(promptsDir(), 'profiles', `${name}.md`), name, 'shipped');
}

/** Language name in English, for the prompts ("Italian"); "auto" and unknown codes fall back to English. */
export function languageName(code: string): string {
  if (code === 'auto') return 'English';
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? 'English'; } catch { return 'English'; }
}

const fill = (template: string, values: Record<string, string>): string =>
  Object.entries(values).reduce((text, [k, v]) => text.split(`{${k}}`).join(v), template);

function writePrompt(outDir: string, name: string, text: string): string {
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, name);
  writeFileSync(file, text, 'utf8');
  return file;
}

/** The main's system-prompt addition (SPEC 10.4, 13.4). Returns the path of the rendered file. */
export function renderMainPrompt(o: { plan: string; workLanguage: string; outDir: string }): string {
  const template = readFileSync(join(promptsDir(), 'main.md'), 'utf8');
  return writePrompt(o.outDir, `main-${o.plan}.md`, fill(template, { plan: o.plan, workLanguage: o.workLanguage }));
}

/** An agent's system-prompt addition: its profile plus who it is and what the console offers it. */
export function renderAgentPrompt(o: { profile: Profile; slug: string; plan: string; outDir: string; git?: { worktree: string; branch: string } }): string {
  const template = readFileSync(join(promptsDir(), 'agent.md'), 'utf8');
  const gitRules = o.git ? fill(readFileSync(join(promptsDir(), 'agent-git.md'), 'utf8'), { worktree: o.git.worktree, branch: o.git.branch, plan: o.plan }) : '';
  const text = fill(template, { slug: o.slug, plan: o.plan, profile: o.profile.body, git: gitRules });
  return writePrompt(o.outDir, `agent-${o.slug}.md`, text.replace(/\n{3,}/g, '\n\n'));
}
