import { existsSync } from 'node:fs';
import type { Context } from '../http';
import { buildClaudeLaunch, SESSION_ID_RE } from '../pty/claude-launch';
import { loadProfile, renderAgentPrompt, type Profile } from '../profiles';
import { validateSlug } from '../../shared/slug';
import { checkSpawnable, createAgentWorktree, createReviewWorktree, discardAgentWorktree, GitError, removeWorktree } from '../git/worktree';
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
export const REVIEWER_TOOLS = ['list_agents', 'review_verdict'].map((t) => `mcp__console-mod__${t}`);
export const RECOVERY_TOOLS = ['list_agents', 'recovery_report'].map((t) => `mcp__console-mod__${t}`);

/** The session's role: a reviewer and a recovery read a detached checkout; every other launched session is an agent. */
const roleOf = (r: SpawnRequest): 'agent' | 'reviewer' | 'recovery' => (r.review ? 'reviewer' : r.recovery ? 'recovery' : 'agent');
/** A detached, read-only checkout of one commit (a reviewer or a recovery): no branch of its own. */
const detachedOf = (r: SpawnRequest): { sha: string; prefix: string } | undefined =>
  r.review ? { sha: r.review.sha, prefix: 'review' } : r.recovery ? { sha: r.recovery.sha, prefix: 'recovery' } : undefined;

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
  const profile = typeof r.profile === 'string' ? loadProfile(r.profile, ctx.planRoot) : undefined;
  if (!profile) return refuse(422, 'profile.invalid');

  const request: SpawnRequest = { ...r, slug: v.slug, model: r.model === '' ? undefined : r.model };
  if (request.model !== undefined && !MODEL_RE.test(request.model)) return refuse(422, 'model.invalid');
  // A reviewer exists only for a delivered ticket: request_review starts it, with the checkout of that commit.
  if (r.profile === 'reviewer' && !r.review) return refuse(422, 'review.useRequestReview');
  // A recovery exists only for a stopped ticket: start_recovery (or the user's answer to a stop) starts it, on the WIP commit.
  if (r.profile === 'recovery' && !r.recovery) return refuse(422, 'recovery.useRecoveryTool');
  if (ctx.git.worktrees) {
    // Found now, before the name is reserved, so the user sees the real reason (SPEC 9.2); the worktree itself is made at start.
    const problem = await checkSpawnable({ repo: ctx.planRoot, plan: ctx.planName, slug: v.slug, review: Boolean(detachedOf(r)) });
    if (problem) return refuse(422, problem);
  }
  try {
    ctx.store.addAgent({ slug: v.slug, profile: r.profile }); // reserves the name, also while it waits in the queue
  } catch (e) {
    return refuse(500, 'agent.spawnFailed', { reason: e instanceof Error ? e.message : String(e) });
  }
  ctx.registry.register({ slug: v.slug, role: roleOf(r), profile: r.profile, goal: r.goal, queued: true, readOnly: profile.readOnly });
  // The review and the report check the work against it. A replacement keeps the objective of the ticket it takes over (its goal
  // here is the handover), and a reviewer or a recovery has no ticket of its own.
  if (r.goal && roleOf(r) === 'agent' && !r.resumeBranch) ctx.tickets.setGoal(v.slug, r.goal);
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
  if (r.resume) {
    // A resumed session goes back to the worktree it was suspended in; nothing new is created. With worktrees off, agents share
    // the plan folder: that is where it goes back to.
    const git = ctx.registry.get(r.slug)?.git;
    if (!git && !ctx.git.worktrees) return startProcess(ctx, r, profile, ctx.planRoot, undefined, bypass);
    if (!git || !existsSync(git.worktree)) throw new Error('no_worktree');
    return startProcess(ctx, r, profile, git.worktree, git, bypass);
  }
  if (!ctx.git.worktrees) return startProcess(ctx, r, profile, ctx.planRoot, undefined, bypass);
  ctx.registry.onSpawned(r.slug);
  return startInWorktree(ctx, r, profile, bypass);
}

async function startInWorktree(ctx: Context, r: SpawnRequest, profile: Profile, bypass: boolean): Promise<void> {
  let made: { path: string; branch: string } | undefined;
  try {
    // A reviewer reads a detached checkout of the delivered commit, a recovery one of the WIP commit; their nominal branch exists
    // nowhere, so the push hook refuses everything. A replacement agent checks out the stopped agent's branch.
    const detached = detachedOf(r);
    made = detached
      ? { path: (await createReviewWorktree({ repo: ctx.planRoot, slug: r.slug, sha: detached.sha })).path, branch: `${detached.prefix}/${r.slug}` }
      : await createAgentWorktree({ repo: ctx.planRoot, plan: ctx.planName, slug: r.slug, ...(r.resumeBranch ? { branch: r.resumeBranch } : {}) });
    await installPushHook({ repo: ctx.planRoot, worktree: made.path, branch: made.branch, slug: r.slug });
    await ctx.afterWorktreeCreated?.(r.slug);
    ctx.registry.setGit(r.slug, { worktree: made.path, branch: made.branch });
    startProcess(ctx, r, profile, made.path, { worktree: made.path, branch: made.branch }, bypass);
  } catch (e) {
    ctx.registry.setGit(r.slug, undefined);
    ctx.tokens.revoke(r.slug);
    // Never delete a branch the console did not just create: a replacement's branch holds the stopped agent's work.
    if (made && (detachedOf(r) || r.resumeBranch)) await removeWorktree(ctx.planRoot, made.path);
    else if (made) await discardAgentWorktree({ repo: ctx.planRoot, slug: r.slug, branch: made.branch, path: made.path });
    throw e;
  }
}

function startProcess(ctx: Context, r: SpawnRequest, profile: Profile, cwd: string, git: { worktree: string; branch: string } | undefined, bypass: boolean): void {
  const launch = buildClaudeLaunch({
    command: ctx.claudeCommand, role: roleOf(r), slug: r.slug, plan: ctx.planName,
    url: `http://127.0.0.1:${ctx.getPort()}`, token: ctx.tokens.issue(r.slug), bypass, baseEnv: process.env,
    pluginDir: ctx.modDir,
    allowedTools: ctx.modDir ? (r.review ? REVIEWER_TOOLS : r.recovery ? RECOVERY_TOOLS : AGENT_TOOLS) : undefined,
    appendPromptFile: renderAgentPrompt({ profile, slug: r.slug, plan: ctx.planName, outDir: ctx.promptsDir, git, review: Boolean(r.review), recovery: Boolean(r.recovery) }),
    model: r.model ?? profile.model,
    ...(r.resume ? { resumeId: r.resume.sessionId } : {}),
  });
  ctx.ptys.spawn({ id: r.slug, ...launch, cwd, cols: 120, rows: 30 });
  ctx.launchLog.set(r.slug, launch.args);
  ctx.registry.onSpawned(r.slug);
  // A token budget needs a worktree (its WIP commits go there); a reviewer and a recovery get none. A restarted server keeps the stored one.
  // The process already runs: a ticket file that cannot be written leaves the agent without a budget (n/a), it does not undo the start.
  if (git && roleOf(r) === 'agent') {
    try {
      ctx.budget.begin(r.slug, r.budget ?? profile.budgetTokens ?? ctx.budgetConfig.agentTokens);
    } catch (e) {
      ctx.inbox.push(ctx.planName, `The token budget of "${r.slug}" could not be recorded (${e instanceof Error ? e.message : String(e)}); it runs without one.`);
    }
  }
  // A resumed session keeps its context: no goal again, only the word to go on (an interactive session waits for a turn).
  if (r.resume) ctx.inbox.push(r.slug, RESUMED_MESSAGE);
  else if (r.goal) ctx.inbox.push(r.slug, goalMessage(r.goal));
  ctx.launchWatch.watch(r.slug);
}

/** What a resumed agent is told first: it has its context, so only that it may go on. */
export const RESUMED_MESSAGE = 'The usage limit was reset and your session was resumed by the console. Continue your ticket from where you stopped: check the state of your checklist and go on with the next open step.';

/**
 * Resumes a suspended agent with `claude --resume <sessionId>` in its EXISTING worktree (SPEC 18.4): same slug, a new session
 * token, no new worktree and no goal message. The active-agent limit still applies: the request goes through the scheduler and,
 * if there is no room, starts by itself when a slot frees.
 */
export async function launchResume(ctx: Context, slug: string, sessionId: string): Promise<{ ok: true } | { ok: false; code: string }> {
  if (!SESSION_ID_RE.test(sessionId)) return { ok: false, code: 'no_session' };
  const a = ctx.registry.get(slug);
  if (!a || a.role !== 'agent') return { ok: false, code: 'not_suspended' };
  if (ctx.ptys.status(slug) === 'running') return { ok: false, code: 'still_running' };
  if (a.git ? !existsSync(a.git.worktree) : ctx.git.worktrees) return { ok: false, code: 'no_worktree' };
  ctx.registry.revive(slug);
  try {
    const result = ctx.scheduler.request({ slug, profile: a.profile, source: 'main', resume: { sessionId } });
    ctx.broadcastState();
    if (result.status === 'started' && result.ready) await result.ready;
    return { ok: true };
  } catch (e) {
    ctx.tokens.revoke(slug);
    ctx.registry.onProcessExit(slug);
    ctx.broadcastState();
    return { ok: false, code: e instanceof Error && e.message === 'no_worktree' ? 'no_worktree' : 'agent.spawnFailed' };
  }
}

/** A queued request whose start failed later: the agent is reported as interrupted, the queue goes on. */
export function failQueuedStart(ctx: Context, r: SpawnRequest): void {
  ctx.tokens.revoke(r.slug);
  ctx.registry.onProcessExit(r.slug);
  if (r.review) ctx.review.abandonReview(r.slug); // the ticket must not stay in review for ever
  if (r.recovery) ctx.recovery.abandon(r.slug); // nor in recovery
  if (r.resume) {
    // A resumed ticket that could not start waits again as suspended, so the main can try once more.
    try { if (ctx.tickets.get(r.slug)?.status === 'in_progress') ctx.tickets.move(r.slug, 'suspended_limit'); } catch { /* told below anyway */ }
    ctx.inbox.push(ctx.planName, `Resuming "${r.slug}" failed when its turn in the queue came; its ticket is suspended again.`);
  }
  if (r.resumeBranch) {
    // A replacement that could not start: its ticket must not stay in_progress with no agent. The branch is intact; the user decides.
    let moved = false;
    try { if (ctx.tickets.get(r.slug)?.status === 'in_progress') { ctx.tickets.move(r.slug, 'needs_user'); moved = true; } } catch { /* told below anyway */ }
    ctx.inbox.push(ctx.planName, `The new agent "${r.slug}" that was to take over branch ${r.resumeBranch} could not start when its turn in the queue came${moved ? '; its ticket now needs the user (needs_user)' : ''}. The branch and its commits are intact. Tell the user.`);
  }
  ctx.broadcastState();
}

async function undoSpawn(ctx: Context, slug: string): Promise<void> {
  await ctx.ptys.discard(slug);
  ctx.tokens.revoke(slug);
  ctx.registry.remove(slug);
  ctx.store.removeAgent(slug);
}
