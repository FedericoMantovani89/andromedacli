import type { Context } from '../http';
import { buildClaudeLaunch } from '../pty/claude-launch';
import { loadProfile, renderAgentPrompt } from '../profiles';
import { validateSlug } from '../../shared/slug';
import type { SpawnRequest } from './scheduler';

export type SpawnOutcome =
  | { ok: true; status: 'started'; slug: string }
  | { ok: true; status: 'queued'; position: number; slug: string }
  | { ok: false; httpStatus: number; code: string; params?: Record<string, string | number> };

/** A model alias or id (opus, claude-opus-5-5[1m]): plain characters only, because it becomes a command-line argument. */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;

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
  try {
    ctx.store.addAgent({ slug: v.slug, profile: r.profile }); // reserves the name, also while it waits in the queue
  } catch (e) {
    return refuse(500, 'agent.spawnFailed', { reason: e instanceof Error ? e.message : String(e) });
  }
  ctx.registry.register({ slug: v.slug, role: 'agent', profile: r.profile, goal: r.goal, queued: true });
  try {
    const result = ctx.scheduler.request(request);
    ctx.broadcastState();
    return result.status === 'started'
      ? { ok: true, status: 'started', slug: v.slug }
      : { ok: true, status: 'queued', position: result.position, slug: v.slug };
  } catch (e) {
    await undoSpawn(ctx, v.slug);
    return refuse(500, 'agent.spawnFailed', { reason: e instanceof Error ? e.message : String(e) });
  }
}

/** Starts the process of an agent (called by the scheduler, now or when a slot frees). May throw. */
export function launchAgent(ctx: Context, r: SpawnRequest): void {
  const profile = loadProfile(r.profile, ctx.planRoot);
  if (!profile) throw new Error(`profile ${r.profile} disappeared`);
  const launch = buildClaudeLaunch({
    command: ctx.claudeCommand, role: 'agent', slug: r.slug, plan: ctx.planName,
    url: `http://127.0.0.1:${ctx.getPort()}`, token: ctx.tokens.issue(r.slug), bypass: ctx.bypass, baseEnv: process.env,
    pluginDir: ctx.modDir,
    allowedTools: ctx.modDir ? ['mcp__console-mod__list_agents'] : undefined,
    appendPromptFile: renderAgentPrompt({ profile, slug: r.slug, plan: ctx.planName, outDir: ctx.promptsDir }),
    model: r.model ?? profile.model,
  });
  ctx.ptys.spawn({ id: r.slug, ...launch, cwd: ctx.planRoot, cols: 120, rows: 30 });
  ctx.launchLog.set(r.slug, launch.args);
  ctx.registry.onSpawned(r.slug);
  if (r.goal) ctx.inbox.push(r.slug, goalMessage(r.goal));
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
