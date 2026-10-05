import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildClaudeLaunch } from './pty/claude-launch';
import { PtyManager } from './pty/pty-manager';
import { PlanStore } from './plan-store';
import { bundlePayload, type Bundles } from './i18n-bundles';
import { extractToken, isAllowedHost, tokensEqual } from './security';
import { validateSlug } from '../shared/slug';
import { PROFILES, type PrereqResult, type SessionInfo, type StateMessage } from '../shared/protocol';
import { patchConfig, validateNotificationsPatch, type ConfigPatch } from './config';
import type { Notifier } from './notify/notifier';
import { parsePresence, type Presence } from './notify/presence';
import type { NotificationService } from './notify/service';
import { fail, readBody, send } from './http-util';
import { handleV1, type V1Context } from './v1';
import { spawnAgent } from './agents/spawn';
import type { Scheduler } from './agents/scheduler';
import type { ReadingStore } from './reading/store';
import type { TicketStore } from './tickets/store';
import type { StepService } from './tickets/steps';
import type { ReviewService } from './tickets/review';
import type { RecoveryService } from './tickets/recovery';
import type { LaunchWatch } from './agents/launch-watch';
import { renderIndex } from './version';
import { isValidTestCommand } from './plan-store';
import { MAX_REWORK_ROUNDS } from './tickets/review';
import type { Config } from './config';
import type { BudgetService } from './budget/service';
import type { Restrictions } from './budget/restrictions';
import type { LoopService } from './budget/loop-service';
import type { Ledger } from './budget/ledger';
import type { QuotaState } from './budget/quota';
import type { SleepTimer } from './budget/sleep';

export interface Context extends V1Context {
  getPort(): number;
  token: string;
  ptys: PtyManager;
  store: PlanStore;
  planName: string;
  planRoot: string;
  claudeCommand: string[];
  /** Mod folder passed to launched sessions (--plugin-dir), when enabled. */
  modDir?: string;
  scheduler: Scheduler;
  reading: ReadingStore;
  /** Last launch arguments per session (a test seam; contains no secrets). */
  launchLog: Map<string, string[]>;
  /** Where rendered system-prompt files are written (under the plan's .console/state). */
  promptsDir: string;
  bypass: boolean;
  language: string;
  bundles: Bundles;
  uiDist: string;
  testMode: boolean;
  configPath: string;
  planIsRepo: boolean;
  /** Build version (latest tag on main), shown on the splash and in the tab title. */
  version: string;
  tickets: TicketStore;
  steps: StepService;
  launchWatch: LaunchWatch;
  review: ReviewService;
  /** Recovery after a stop (SPEC 16.5). */
  recovery: RecoveryService;
  /** Token budgets (Phase 5): limits, steps and the usage shown in the state. */
  budget: BudgetService;
  /** What the guard holds against each session (budget, loop, limit). */
  restrictions: Restrictions;
  /** Loop handling: the level shown in the state. */
  loop: LoopService;
  ledger: Ledger;
  /** The subscription's usage limits as the engine last reported them (SPEC 18.1). */
  quotaState: QuotaState;
  /** Sleep until a usage limit lifts (SPEC 18.4). */
  sleep: SleepTimer;
  /** Read at each use: a change made in the Settings dialog applies to the sessions launched afterwards. */
  readonly git: Config['git'];
  /** The budget thresholds and the default token limit, read at each launch. */
  readonly budgetConfig: Config['budget'];
  readonly guardMode: Config['guard']['mode'];
  /** A test seam: runs after an agent's worktree exists and before its process starts (a throw simulates a failed start). */
  afterWorktreeCreated?: (slug: string) => void | Promise<void>;
  getPrereq(): PrereqResult[] | null;
  /** Resolves with the checks, waiting for the startup run if it has not finished (unknown is never ok, P7). */
  ensurePrereq(): Promise<PrereqResult[]>;
  refreshPrereq(): Promise<PrereqResult[]>;
  setLanguage(language: string): void;
  /** Changes what sessions launched from now on get (the bypass switch, the guard mode). Running sessions are untouched. */
  applySettings(s: { bypass?: boolean; guardMode?: 'enforce' | 'shadow' }): void;
  /** Called when a session is launched: fixes the settings that session will live with and returns what the launch needs. */
  noteLaunch(slug: string): { bypass: boolean };
  needsSetup(): boolean;
  broadcastState(): void;
  /** Phase 6B: unique for the whole console (6C shares it between plans). */
  notifier: Notifier;
  /** What the user is looking at, as the UI last reported it. */
  presence: Presence;
  notify: NotificationService;
  /** Read at each event. */
  readonly notificationsConfig: Config['notifications'];
  applyNotifications(n: Config['notifications']): void;
}

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.js.map': { file: 'app.js.map', type: 'application/json' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/splash.jpg': { file: 'splash.jpg', type: 'image/jpeg' },
  '/xterm.css': { file: 'xterm.css', type: 'text/css; charset=utf-8' },
};

export function buildState(ctx: Context): StateMessage {
  const status = (slug: string): SessionInfo['status'] => {
    const p = ctx.ptys.status(slug);
    return p === 'running' ? 'running' : p === 'exited' ? 'exited' : 'pending';
  };
  const stateOf = (slug: string) => ctx.registry.get(slug)?.state ?? 'starting';
  // studying / blocked / progress come from the agent's ticket, never from the terminal.
  const derived = (slug: string): Pick<SessionInfo, 'state' | 'progress' | 'ticket' | 'budget'> => {
    const rt = ctx.registry.get(slug);
    const ticket = rt ? ctx.tickets.get(slug) : undefined;
    // A ticket stopped by its budget or by the usage limit, whose process is gone, waits for a decision: not finished, not failed.
    const suspended = (ticket?.status === 'suspended_budget' || ticket?.status === 'suspended_limit') && ctx.ptys.status(slug) !== 'running';
    const base = suspended ? 'suspended' : stateOf(slug);
    // Where the ticket is in the review pipeline: kept after the worktree is gone (a merged ticket still says "Merged").
    const pipeline = ticket && rt?.role === 'agent' && (ticket.status !== 'in_progress' || ticket.round > 0)
      ? { ticket: { status: ticket.status, round: ticket.round, maxRounds: MAX_REWORK_ROUNDS } }
      : {};
    // No budget (a reviewer, an agent without a worktree) is left out, so the UI shows n/a rather than zero.
    const usage = rt?.role === 'agent' ? ctx.budget.usage(slug) : undefined;
    const budget = usage ? { budget: usage } : {};
    if (!rt?.git) return { state: base, ...pipeline, ...budget };
    const total = ticket?.steps.length ?? 0;
    const progress = total > 0 ? { done: ticket!.steps.filter((x) => x.done).length, total } : undefined;
    let state = base;
    if (ticket?.blocked && base !== 'interrupted' && base !== 'queued' && base !== 'waiting_user' && base !== 'suspended') state = 'blocked';
    else if (total === 0 && base === 'working') state = 'studying';
    return { state, ...(progress ? { progress } : {}), ...pipeline, ...budget };
  };
  const main: SessionInfo = { slug: ctx.planName, profile: 'main', role: 'main', status: status(ctx.planName), state: stateOf(ctx.planName) };
  // Only sessions of this run: agents saved by an earlier run are history (resume is Phase 6) and keep their slug reserved.
  const agents: SessionInfo[] = ctx.store.listAgents()
    .filter((a) => ctx.ptys.status(a.slug) !== 'unknown' || ctx.registry.get(a.slug) !== undefined)
    .map((a) => ({ slug: a.slug, profile: a.profile, role: 'agent', status: status(a.slug), ...derived(a.slug), ...(ctx.launchWatch.stalled(a.slug) ? { launchStalled: true } : {}), ...(ctx.loop.level(a.slug) > 0 ? { loop: ctx.loop.level(a.slug) as 1 | 2 | 3 } : {}) }));
  let testCommand: string | undefined;
  let squash: boolean | undefined;
  try { ({ testCommand, squash } = ctx.store.plan); } catch { /* a damaged plan.json: shown as not set */ }
  const worst = ctx.quotaState.worst();
  const slept = ctx.sleep.state();
  return {
    ...(worst ? { quota: { percent: worst.percent, kind: worst.kind } } : {}),
    ...(slept.phase !== 'awake' ? { sleep: { ...(slept.until !== undefined ? { until: slept.until } : {}), phase: slept.phase, attempt: slept.attempt, weekly: slept.kind === 'seven_day' } } : {}),
    // One plan per console today: the stricter of the global and the per-plan limit is the one that holds.
    limits: { active: ctx.scheduler.activeCount(), max: (({ global, perPlan }) => Math.min(global, perPlan))(ctx.scheduler.effectiveLimits()) },
    type: 'state', plan: { name: ctx.planName, ...(testCommand ? { testCommand } : {}), ...(squash !== undefined ? { squash } : {}) }, settings: { bypassPermissions: ctx.bypass, guardMode: ctx.guardMode, worktrees: ctx.git.worktrees }, main, agents, language: ctx.language, languages: [...ctx.bundles.keys()].sort(), profiles: PROFILES,
    prereq: ctx.getPrereq(), needsSetup: ctx.needsSetup(), planIsRepo: ctx.planIsRepo, planRoot: ctx.planRoot,
    queue: ctx.questions.pending(),
    notifications: { toast: ctx.notify.toast(), config: ctx.notificationsConfig },
  };
}

export function createRequestHandler(ctx: Context) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isAllowedHost(req.headers.host, ctx.getPort())) return fail(res, 403, 'forbidden');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${ctx.getPort()}`);
    const path = url.pathname;

    // Static UI files: no token needed, the page itself carries the token in its URL.
    const asset = req.method === 'GET' ? STATIC[path] : undefined;
    if (asset) {
      const file = join(ctx.uiDist, asset.file);
      if (!existsSync(file)) return fail(res, 404, 'not_found');
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
      res.end(path === '/' ? renderIndex(readFileSync(file, 'utf8'), ctx.version) : readFileSync(file));
      return;
    }

    // UI texts are not secret and the page needs them to explain a wrong token, so they only need the Host check.
    const i18n = /^\/i18n\/(\w+)$/.exec(path);
    if (req.method === 'GET' && i18n) {
      const payload = bundlePayload(ctx.bundles, i18n[1]!);
      return payload ? send(res, 200, payload) : fail(res, 404, 'not_found');
    }

    // The mod channel has its own authentication (per-session tokens); the UI token is not valid there.
    if (path.startsWith('/v1/')) return handleV1(ctx, req, res, url);

    const token = extractToken(req.headers, url);
    if (!token || !tokensEqual(token, ctx.token)) return fail(res, 401, 'unauthorized');

    if (req.method === 'GET' && path === '/api/state') return send(res, 200, buildState(ctx));

    if (req.method === 'GET' && ctx.testMode) {
      const snap = /^\/api\/debug\/snapshot\/([a-z0-9-]+)$/.exec(path);
      if (snap) return send(res, 200, { text: ctx.ptys.snapshot(snap[1]!).toString('utf8') });
      const size = /^\/api\/debug\/size\/([a-z0-9-]+)$/.exec(path);
      if (size) return send(res, 200, ctx.ptys.size(size[1]!) ?? {});
    }

    if (req.method === 'POST' && path === '/api/agents') {
      let body: unknown;
      try { body = await readBody(req); } catch { return fail(res, 400, 'bad_request'); }
      const b = (typeof body === 'object' && body !== null ? body : {}) as { slug?: unknown; profile?: unknown };
      // The UI button (a user) and the main's spawn_agent tool share one flow: validation, name reservation, limits.
      const out = await spawnAgent(ctx, { slug: String(b.slug ?? ''), profile: String(b.profile ?? ''), source: 'user' });
      if (!out.ok) return fail(res, out.httpStatus, out.code, out.params);
      return out.status === 'started' ? send(res, 201, { slug: out.slug }) : send(res, 202, { slug: out.slug, status: 'queued', position: out.position });
    }

    const reading = /^\/api\/reading\/([\w-]+)$/.exec(path);
    if (req.method === 'GET' && reading) return send(res, 200, { entries: ctx.reading.list(reading[1]!) });

    const answer = /^\/api\/queue\/([\w-]+)\/answer$/.exec(path);
    if (req.method === 'POST' && answer) {
      let body: unknown;
      try { body = await readBody(req); } catch { return fail(res, 400, 'bad_request'); }
      const text = (body as { answer?: unknown } | null)?.answer;
      if (typeof text !== 'string') return fail(res, 400, 'bad_request');
      const outcome = ctx.questions.answer(answer[1]!, text);
      if (outcome === 'ok') return send(res, 200, { ok: true });
      return outcome === 'unknown' ? fail(res, 404, 'not_found') : outcome === 'already' ? fail(res, 409, 'already_answered') : fail(res, 400, 'bad_request');
    }

    // "Resume now": one probe at once instead of waiting for the reset time. The token check above already ran.
    if (req.method === 'POST' && path === '/api/sleep/resume') {
      ctx.sleep.resumeNow();
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'POST' && path === '/api/prereq/recheck') return send(res, 200, await ctx.refreshPrereq());

    // Phase 6B: what the user is looking at (heartbeat of the UI), and the "send a test toast" button.
    if (req.method === 'POST' && path === '/api/presence') {
      let body: unknown;
      try { body = await readBody(req); } catch { return fail(res, 400, 'bad_request'); }
      const report = parsePresence(body);
      if (!report) return fail(res, 400, 'bad_request');
      ctx.presence.report(report);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'POST' && path === '/api/notifications/test') {
      const ok = await ctx.notify.test();
      ctx.broadcastState();
      return send(res, 200, { ok });
    }

    if (req.method === 'PUT' && path === '/api/config') {
      let body: unknown;
      try { body = await readBody(req); } catch { return fail(res, 400, 'bad_request'); }
      const b = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
      const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
      const patch: ConfigPatch = {};
      // Every entry is checked before anything is written: a bad one changes nothing.
      if ('language' in b) {
        if (typeof b.language !== 'string' || (b.language !== 'auto' && !ctx.bundles.has(b.language))) return fail(res, 422, 'config.invalid', { path: 'language' });
        patch.language = b.language;
      }
      if ('agents' in b) {
        if (!isObj(b.agents)) return fail(res, 422, 'config.invalid', { path: 'agents' });
        if (typeof b.agents.bypassPermissions !== 'boolean') return fail(res, 422, 'config.invalid', { path: 'agents.bypassPermissions' });
        patch.agents = { bypassPermissions: b.agents.bypassPermissions };
      }
      if ('guard' in b) {
        if (!isObj(b.guard)) return fail(res, 422, 'config.invalid', { path: 'guard' });
        if (b.guard.mode !== 'enforce' && b.guard.mode !== 'shadow') return fail(res, 422, 'config.invalid', { path: 'guard.mode' });
        patch.guard = { mode: b.guard.mode };
      }
      if ('notifications' in b) {
        const checked = validateNotificationsPatch(b.notifications, ctx.notificationsConfig);
        if (!checked.ok) return fail(res, 422, 'config.invalid', { path: checked.path });
        patch.notifications = checked.value;
      }
      if (Object.keys(patch).length === 0) return fail(res, 422, 'config.invalid', { path: '' });
      const saved = patchConfig(ctx.configPath, patch);
      if (!saved.ok) return fail(res, 409, saved.code);
      if (patch.notifications) ctx.applyNotifications(patch.notifications);
      if (patch.language !== undefined) ctx.setLanguage(patch.language);
      if (patch.agents || patch.guard) ctx.applySettings({ bypass: patch.agents?.bypassPermissions, guardMode: patch.guard?.mode });
      ctx.broadcastState();
      return send(res, 200, patch);
    }

    if (req.method === 'PUT' && path === '/api/plan') {
      let body: unknown;
      try { body = await readBody(req); } catch { return fail(res, 400, 'bad_request'); }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail(res, 400, 'bad_request');
      const b = body as Record<string, unknown>;
      const hasCommand = 'testCommand' in b;
      const hasSquash = 'squash' in b;
      if (!hasCommand && !hasSquash) return fail(res, 400, 'bad_request');
      // Everything is checked before anything is written: a bad entry changes nothing.
      if (hasSquash && typeof b.squash !== 'boolean') return fail(res, 422, 'plan.squashInvalid');
      if (hasCommand && !isValidTestCommand(b.testCommand)) return fail(res, 422, 'plan.testCommandInvalid');
      if (hasCommand) ctx.store.setTestCommand(b.testCommand as string);
      if (hasSquash) ctx.store.setSquash(b.squash as boolean);
      ctx.broadcastState();
      const saved = ctx.store.plan;
      return send(res, 200, { ...(hasCommand && saved.testCommand ? { testCommand: saved.testCommand } : {}), ...(hasSquash ? { squash: b.squash } : {}) });
    }

    return fail(res, 404, 'not_found');
  };
}
