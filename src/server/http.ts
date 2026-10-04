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
import { patchConfig, type ConfigPatch } from './config';
import { fail, readBody, send } from './http-util';
import { handleV1, type V1Context } from './v1';
import { spawnAgent } from './agents/spawn';
import type { Scheduler } from './agents/scheduler';
import type { ReadingStore } from './reading/store';
import type { TicketStore } from './tickets/store';
import type { StepService } from './tickets/steps';
import type { LaunchWatch } from './agents/launch-watch';
import type { Config } from './config';

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
  tickets: TicketStore;
  steps: StepService;
  launchWatch: LaunchWatch;
  /** Read at each use: a change made in the Settings dialog applies to the sessions launched afterwards. */
  readonly git: Config['git'];
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
  const derived = (slug: string): Pick<SessionInfo, 'state' | 'progress'> => {
    const base = stateOf(slug);
    if (!ctx.registry.get(slug)?.git) return { state: base };
    const ticket = ctx.tickets.get(slug);
    const total = ticket?.steps.length ?? 0;
    const progress = total > 0 ? { done: ticket!.steps.filter((x) => x.done).length, total } : undefined;
    let state = base;
    if (ticket?.blocked && base !== 'interrupted' && base !== 'queued' && base !== 'waiting_user') state = 'blocked';
    else if (total === 0 && base === 'working') state = 'studying';
    return { state, ...(progress ? { progress } : {}) };
  };
  const main: SessionInfo = { slug: ctx.planName, profile: 'main', role: 'main', status: status(ctx.planName), state: stateOf(ctx.planName) };
  // Only sessions of this run: agents saved by an earlier run are history (resume is Phase 6) and keep their slug reserved.
  const agents: SessionInfo[] = ctx.store.listAgents()
    .filter((a) => ctx.ptys.status(a.slug) !== 'unknown' || ctx.registry.get(a.slug) !== undefined)
    .map((a) => ({ slug: a.slug, profile: a.profile, role: 'agent', status: status(a.slug), ...derived(a.slug), ...(ctx.launchWatch.stalled(a.slug) ? { launchStalled: true } : {}) }));
  let testCommand: string | undefined;
  try { testCommand = ctx.store.plan.testCommand; } catch { /* a damaged plan.json: shown as not set */ }
  return {
    type: 'state', plan: { name: ctx.planName, ...(testCommand ? { testCommand } : {}) }, settings: { bypassPermissions: ctx.bypass, guardMode: ctx.guardMode, worktrees: ctx.git.worktrees }, main, agents, language: ctx.language, languages: [...ctx.bundles.keys()].sort(), profiles: PROFILES,
    prereq: ctx.getPrereq(), needsSetup: ctx.needsSetup(), planIsRepo: ctx.planIsRepo, planRoot: ctx.planRoot,
    queue: ctx.questions.pending(),
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
      res.end(readFileSync(file));
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

    if (req.method === 'POST' && path === '/api/prereq/recheck') return send(res, 200, await ctx.refreshPrereq());

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
      if (Object.keys(patch).length === 0) return fail(res, 422, 'config.invalid', { path: '' });
      const saved = patchConfig(ctx.configPath, patch);
      if (!saved.ok) return fail(res, 409, saved.code);
      if (patch.language !== undefined) ctx.setLanguage(patch.language);
      if (patch.agents || patch.guard) ctx.applySettings({ bypass: patch.agents?.bypassPermissions, guardMode: patch.guard?.mode });
      ctx.broadcastState();
      return send(res, 200, patch);
    }

    if (req.method === 'PUT' && path === '/api/plan') {
      let body: unknown;
      try { body = await readBody(req); } catch { return fail(res, 400, 'bad_request'); }
      if (typeof body !== 'object' || body === null || !('testCommand' in body)) return fail(res, 400, 'bad_request');
      try {
        ctx.store.setTestCommand((body as { testCommand: string }).testCommand);
      } catch {
        return fail(res, 422, 'plan.testCommandInvalid');
      }
      ctx.broadcastState();
      const saved = ctx.store.plan.testCommand;
      return send(res, 200, saved ? { testCommand: saved } : {});
    }

    return fail(res, 404, 'not_found');
  };
}
