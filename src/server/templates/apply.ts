import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { PROFILES } from '../../shared/protocol';
import { git } from '../git/git';
import { PlanStore } from '../plan-store';
import { detectProject } from './detect';
import { findTemplate, TEMPLATE_ID_RE } from './load';

export type ApplyResult = { ok: true } | { ok: false; code: string; detail?: string };

export interface ApplyOptions {
  templateId: string;
  root: string;
  name: string;
  /** Create the folder, and make it a git repository when it is not one. */
  create: boolean;
  /** Make the folder a git repository when it is not one, without creating it (the user asked for it). */
  init?: boolean;
  /** What the user typed: beats the detected commands, which beat the template's. An empty string means none. */
  build?: string;
  test?: string;
  lint?: string;
  configDir: string;
  /** Tests: another folder of shipped templates. */
  shippedDir?: string;
}

const PROFILE_FILE_RE = /^[a-z0-9]+(-[a-z0-9]+)*\.md$/;
const copyIfPresent = (from: string, to: string): void => { if (existsSync(from)) copyFileSync(from, to); };

/** True when `root` is inside a git work tree. */
async function isRepo(root: string): Promise<boolean> {
  return (await git(root, ['rev-parse', '--git-dir'])).code === 0;
}

/** `git init -b main` and an empty first commit, so the plan branch and the worktrees have something to start from. */
async function initRepo(root: string): Promise<ApplyResult> {
  if (!(await isRepo(root))) {
    const init = await git(root, ['init', '-b', 'main']);
    if (init.code !== 0) return { ok: false, code: 'git.notRepo', detail: init.stderr.trim() };
  }
  if ((await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0) return { ok: true }; // already has a commit
  // The identity is only supplied when the user has none, so a machine without one never fails here (and one with one is left alone).
  const hasName = (await git(root, ['config', 'user.name'])).stdout.trim() !== '';
  const hasEmail = (await git(root, ['config', 'user.email'])).stdout.trim() !== '';
  const env: Record<string, string> = {};
  if (!hasName) Object.assign(env, { GIT_AUTHOR_NAME: 'Console', GIT_COMMITTER_NAME: 'Console' });
  if (!hasEmail) Object.assign(env, { GIT_AUTHOR_EMAIL: 'console@localhost', GIT_COMMITTER_EMAIL: 'console@localhost' });
  const commit = await git(root, ['commit', '--allow-empty', '-m', 'chore: start'], { env });
  return commit.code === 0 ? { ok: true } : { ok: false, code: 'git.noCommits', detail: commit.stderr.trim() };
}

/**
 * Makes a plan from a template (SPEC 21.2): the folder (and its repository) if asked, the template's profiles, main.md and rules.md
 * under `.console/`, and the plan.json fields. Every step is idempotent. The project's own CLAUDE.md is never written: it would
 * dirty the user's checkout and would not reach the worktrees (the rules travel in `.console/rules.md` instead).
 */
export async function applyTemplate(o: ApplyOptions): Promise<ApplyResult> {
  if (!TEMPLATE_ID_RE.test(o.templateId)) return { ok: false, code: 'template.notFound' };
  const template = findTemplate(o.templateId, { configDir: o.configDir, shippedDir: o.shippedDir });
  if (!template) return { ok: false, code: 'template.notFound' };
  if (!template.valid || !template.data) return { ok: false, code: 'template.invalid', detail: template.reason };
  const data = template.data;

  if (typeof o.root !== 'string' || o.root.trim() === '' || !isAbsolute(o.root)) return { ok: false, code: 'plan.badRoot' };
  const root = resolve(o.root);
  try {
    if (o.create) mkdirSync(root, { recursive: true });
    else if (!existsSync(root) || !statSync(root).isDirectory()) return { ok: false, code: 'plan.badRoot' };
  } catch (e) {
    return { ok: false, code: 'plan.badRoot', detail: e instanceof Error ? e.message : String(e) };
  }

  if (o.create || o.init) {
    const repo = await initRepo(root);
    if (!repo.ok) return repo;
  }

  try {
    const consoleDir = join(root, '.console');
    mkdirSync(consoleDir, { recursive: true });
    const profilesSrc = join(template.dir, 'profiles');
    if (existsSync(profilesSrc)) {
      const profilesDst = join(consoleDir, 'profiles');
      mkdirSync(profilesDst, { recursive: true });
      for (const f of readdirSync(profilesSrc)) if (PROFILE_FILE_RE.test(f)) copyFileSync(join(profilesSrc, f), join(profilesDst, f));
    }
    copyIfPresent(join(template.dir, 'main.md'), join(consoleDir, 'main.md'));
    copyIfPresent(join(template.dir, 'rules.md'), join(consoleDir, 'rules.md'));

    const store = new PlanStore(root);
    store.init(o.name);
    // What the user typed beats what was detected, which beats the template's own command.
    const detected = data.detect ? detectProject(root) : {};
    const pick = (typed: string | undefined, found: string | undefined, fromTemplate: string | undefined): string | undefined =>
      typed !== undefined ? typed : found ?? fromTemplate;
    store.setFields({
      buildCommand: pick(o.build, detected.build, data.commands.build),
      lintCommand: pick(o.lint, detected.lint, data.commands.lint),
      profiles: data.profiles,
      model: data.defaults.model,
      agentTokens: data.defaults.agentTokens,
      maxActive: data.defaults.maxActive,
      docs: data.docs,
      secretPatterns: data.git.secretPatterns,
    }, PROFILES);
    const test = pick(o.test, detected.test, data.commands.test);
    if (test !== undefined) store.setTestCommand(test);
    if (data.git.squash !== undefined) store.setSquash(data.git.squash);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, code: message.startsWith('plan.') ? message.split(':')[0]! : 'plan.badRoot', detail: message };
  }
  return { ok: true };
}
