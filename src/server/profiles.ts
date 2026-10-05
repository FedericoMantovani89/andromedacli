import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configDir } from './config';

export interface Profile {
  name: string;
  description: string;
  model?: string;
  /** The text added to the system prompt (frontmatter removed; `console:` keys are the console's, not Claude's). */
  body: string;
  /** `console: read_only: true`: the session may not change anything (a reviewer); enforced by the guard. */
  readOnly: boolean;
  /** `console: budget_tokens: N`: the token budget of this profile's sessions (SPEC 16); absent means the configured default. */
  budgetTokens?: number;
  source: 'plan' | 'user' | 'shipped';
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const promptsDir = (): string => resolve(import.meta.dirname, '..', '..', 'prompts');

/** Frontmatter subset: top-level `key: value` lines; nested blocks (like `console:`) are skipped. */
function parseFrontmatter(text: string): { meta: Record<string, string>; consoleKeys: Record<string, string>; body: string } {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { meta: {}, consoleKeys: {}, body: normalized.trim() };
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return { meta: {}, consoleKeys: {}, body: normalized.trim() };
  const meta: Record<string, string> = {};
  const consoleKeys: Record<string, string> = {};
  let block = '';
  for (const line of normalized.slice(4, end).split('\n')) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line); // indented lines do not match: they belong to a nested block
    if (m) {
      block = m[2] === '' ? m[1]! : '';
      if (m[2] !== '') meta[m[1]!] = m[2]!.trim();
      continue;
    }
    const nested = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (nested && block === 'console') consoleKeys[nested[1]!] = nested[2]!.trim();
  }
  return { meta, consoleKeys, body: normalized.slice(end + 4).replace(/^\n+/, '').trim() };
}

function readProfile(file: string, name: string, source: Profile['source']): Profile | undefined {
  if (!existsSync(file)) return undefined;
  const { meta, consoleKeys, body } = parseFrontmatter(readFileSync(file, 'utf8'));
  const model = meta.model && meta.model !== 'default' && /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/.test(meta.model) ? meta.model : undefined;
  const bt = Number(consoleKeys.budget_tokens);
  const budgetTokens = Number.isInteger(bt) && bt >= 1000 ? bt : undefined;
  return { name, description: meta.description ?? '', model, body, readOnly: consoleKeys.read_only === 'true', budgetTokens, source };
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

const MAX_PLAN_TEXT = 32 * 1024;

/** A plan's own text file (`.console/main.md`, `.console/rules.md`), bounded; undefined when it is missing, empty or unreadable. */
function planText(planRoot: string | undefined, file: 'main.md' | 'rules.md'): string | undefined {
  if (!planRoot) return undefined;
  try {
    const path = join(planRoot, '.console', file);
    if (!existsSync(path)) return undefined;
    const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').trim();
    return text === '' ? undefined : text.slice(0, MAX_PLAN_TEXT);
  } catch {
    return undefined;
  }
}

/** The main's system-prompt addition (SPEC 10.4, 13.4). Returns the path of the rendered file. With `planRoot`, the plan's main.md and rules.md follow. */
export function renderMainPrompt(o: { plan: string; workLanguage: string; outDir: string; planRoot?: string }): string {
  const template = readFileSync(join(promptsDir(), 'main.md'), 'utf8');
  const base = fill(template, { plan: o.plan, workLanguage: o.workLanguage });
  const extra = [planText(o.planRoot, 'main.md'), planText(o.planRoot, 'rules.md')].filter((x): x is string => x !== undefined);
  return writePrompt(o.outDir, `main-${o.plan}.md`, extra.length > 0 ? `${base.trimEnd()}\n\n${extra.join('\n\n')}\n` : base);
}

/** An agent's system-prompt addition: its profile plus who it is and what the console offers it. */
export function renderAgentPrompt(o: { profile: Profile; slug: string; plan: string; outDir: string; git?: { worktree: string; branch: string }; review?: boolean; recovery?: boolean; planRoot?: string; docs?: string[] }): string {
  const template = readFileSync(join(promptsDir(), 'agent.md'), 'utf8');
  const rulesFile = o.review ? 'reviewer-git.md' : o.recovery ? 'recovery-git.md' : 'agent-git.md';
  const gitRules = o.git ? fill(readFileSync(join(promptsDir(), rulesFile), 'utf8'), { worktree: o.git.worktree, branch: o.git.branch, plan: o.plan }) : '';
  const text = fill(template, { slug: o.slug, plan: o.plan, profile: o.profile.body, git: gitRules });
  // The plan's rules reach every session; the documents to update concern only the one that writes the work (not a review or a recovery).
  const docs = o.docs && o.docs.length > 0 && !o.review && !o.recovery ? `At the last step update: ${o.docs.join(', ')}.` : undefined;
  const extra = [planText(o.planRoot, 'rules.md'), docs].filter((x): x is string => x !== undefined);
  const full = extra.length > 0 ? `${text.trimEnd()}\n\n${extra.join('\n\n')}\n` : text;
  return writePrompt(o.outDir, `agent-${o.slug}.md`, full.replace(/\n{3,}/g, '\n\n'));
}
