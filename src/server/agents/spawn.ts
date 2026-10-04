import type { Context } from '../http';
import { buildClaudeLaunch } from '../pty/claude-launch';
import { loadProfile, renderAgentPrompt, type Profile } from '../profiles';
import { validateSlug } from '../../shared/slug';
import { checkSpawnable, createAgentWorktree, discardAgentWorktree, GitError } from '../git/worktree';
import { installPushHook } from '../git/hooks';
import type { SpawnRequest } from './scheduler';

export type SpawnOutcome =
  | { ok: true; status: 'started'; slug: string }
  | { ok: true; status: 'queued'; position: number; slug: string }
  | { ok: false; httpStatus: number; code: string; params?: Record<string, string | number> };

/** A model alias or id (opus, claude-opus-5-5[1m]): plain characters only, because it becomes a command-line argument. */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;

/** The console's own tools an agent may call without a permission prompt. */
export const AGENT_TOOLS = ['list_agents', 'checklist_set', 'step_done', 'report_blocked'].map((t) => `mcp__console-mod__${t}`);

const refuse = (httpStatus: number, code: string, params?: Record<string, string | number>): SpawnOutcome =>
  ({ ok: false, httpStatus, code, params });

/** What the new agent is told first. Delivered through the inbox, so the mod injects it as the first turn. */
export const goalMessage = (goal: string): string =>
  `Your goal for this activity (written by the main session):\n\n${goal}\n\nStart now.`;

/**
 * The single way an agent comes to exist: the UI button and the main's spawn_agent tool both end here.
 * Validates, reserves the name, and lets the scheduler decide between starting now and waiting for a slot.
 */
export async function spawnAgent(ctx: Context, r: SpawnRequest): Promise<SpawnOutcome> {
  const blocked = (await ctx.ensurePrereq()).find((c) => c.required && c.status !== 'ok');
  if (blocked) return refuse(422, 'prereq.blocked', { tool: blocked.id });

  const v = validateSlug(r.slug, [ctx.planName, ...ctx.store.listAgents().map((a) => a.slug)]);
  if (!v.ok) return refuse(422, v.code, v.params);
  if (typeof r.profile !== 'string' || !loadProfile(r.profile, ctx.planRoot)) return refuse(422, 'profile.invalid');

  const request: SpawnRequest = { ...r, slug: v.slug, model: r.model === '' ? undefined : r.model };
  if (request.model !== undefined && !MODEL_RE.test(request.model)) return refuse(422, 'model.invalid');
  if (ctx.git.worktrees) {
    // Found now, before the name is reserved, so the user sees the real reason (SPEC 9.2); the worktree itself is made at start.
    const problem = await checkSpawnable({ repo: ctx.planRoot, plan: ctx.planName, slug: v.slug });
    if (problem) return refuse(422, problem);
  }
  try {
    ctx.store.addAgent({ slug: v.slug, profile: r.profile }); // reserves the name, also while it waits in the queue
  } catch (e) {
    return refuse(500, 'agent.spawnFailed', { reason: e instanceof Error ? e.message : String(e) });
  }
  ctx.registry.register({ slug: v.slug, role: 'agent', profile: r.profile, goal: r.goal, queued: true });
  try {
    const result = ctx.scheduler.request(request);
    ctx.broadcastState();
    if (result.status === 'started' && result.ready) await result.ready;
    return result.status === 'started'
      ? { ok: true, status: 'started', slug: v.slug }
      : { ok: true, status: 'queued', position: result.position, slug: v.slug };
  } catch (e) {
    await undoSpawn(ctx, v.slug);
    ctx.broadcastState();
    if (e instanceof GitError && e.code !== 'git.failed') return refuse(422, e.code);
    return refuse(500, 'agent.spawnFailed', { reason: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Starts the process of an agent (called by the scheduler, now or when a slot frees). May throw. With worktrees on, the start is
 * asynchronous: the slot is taken at once, the worktree and its hook are made, and only then does the process start.
 */
export function launchAgent(ctx: Context, r: SpawnRequest): void | Promise<void> {
  const profile = loadProfile(r.profile, ctx.planRoot);
  if (!profile) throw new Error(`profile ${r.profile} disappeared`);
  const { bypass } = ctx.noteLaunch(r.slug); // the settings of this moment, even if the worktree takes a while
  if (!ctx.git.worktrees) return startProcess(ctx, r, profile, ctx.planRoot, undefined, bypass);
  ctx.registry.onSpawned(r.slug);
  return startInWorktree(ctx, r, profile, bypass);
}

async function startInWorktree(ctx: Context, r: SpawnRequest, profile: Profile, bypass: boolean): Promise<void> {
  let made: { path: string; branch: string } | undefined;
  try {
    made = await createAgentWorktree({ repo: ctx.planRoot, plan: ctx.planName, slug: r.slug });
    await installPushHook({ repo: ctx.planRoot, worktree: made.path, branch: made.branch, slug: r.slug });
    await ctx.afterWorktreeCreated?.(r.slug);
    ctx.registry.setGit(r.slug, { worktree: made.path, branch: made.branch });
    startProcess(ctx, r, profile, made.path, { worktree: made.path, branch: made.branch }, bypass);
  } catch (e) {
    ctx.registry.setGit(r.slug, undefined);
    ctx.tokens.revoke(r.slug);
    if (made) await discardAgentWorktree({ repo: ctx.planRoot, slug: r.slug, branch: made.branch, path: made.path });
    throw e;
  }
}

function startProcess(ctx: Context, r: SpawnRequest, profile: Profile, cwd: string, git: { worktree: string; branch: string } | undefined, bypass: boolean): void {
  const launch = buildClaudeLaunch({
    command: ctx.claudeCommand, role: 'agent', slug: r.slug, plan: ctx.planName,
    url: `http://127.0.0.1:${ctx.getPort()}`, token: ctx.tokens.issue(r.slug), bypass, baseEnv: process.env,
    pluginDir: ctx.modDir,
    allowedTools: ctx.modDir ? AGENT_TOOLS : undefined,
    appendPromptFile: renderAgentPrompt({ profile, slug: r.slug, plan: ctx.planName, outDir: ctx.promptsDir, git }),
    model: r.model ?? profile.model,
  });
  ctx.ptys.spawn({ id: r.slug, ...launch, cwd, cols: 120, rows: 30 });
  ctx.launchLog.set(r.slug, launch.args);
  ctx.registry.onSpawned(r.slug);
  if (r.goal) ctx.inbox.push(r.slug, goalMessage(r.goal));
  ctx.launchWatch.watch(r.slug);
}

/** A queued request whose start failed later: the agent is reported as interrupted, the queue goes on. */
export function failQueuedStart(ctx: Context, r: SpawnRequest): void {
  ctx.tokens.revoke(r.slug);
  ctx.registry.onProcessExit(r.slug);
  ctx.broadcastState();
}

async function undoSpawn(ctx: Context, slug: string): Promise<void> {
  await ctx.ptys.discard(slug);
  ctx.tokens.revoke(slug);
  ctx.registry.remove(slug);
  ctx.store.removeAgent(slug);
}
