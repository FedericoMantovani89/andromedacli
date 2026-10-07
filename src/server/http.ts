import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { buildClaudeLaunch } from './pty/claude-launch';
import { PtyManager } from './pty/pty-manager';
import { ProjectStore } from './project-store';
import { bundlePayload, type Bundles } from './i18n-bundles';
import { extractToken, isAllowedHost, tokensEqual } from './security';
import { GENERIC_WORDS, SLUG_MAX, SLUG_MIN, validateSlug } from '../shared/slug';
import { PROFILES, type HostInfo, type ProjectTab, type PrereqResult, type SessionInfo, type StateMessage } from '../shared/protocol';
import { applyConfigPatch, loadConfig } from './config';
import type { PickFolderResult } from './pick-folder';
import type { Notifier } from './notify/notifier';
import { parsePresence, type Presence } from './notify/presence';
import type { NotificationService } from './notify/service';
import { loadProfile } from './profiles';
import type { ModelCatalog } from './catalog/models';
import type { PluginCatalog } from './catalog/plugins';
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
import { isValidProjectField, isValidTestCommand, PROJECT_FIELDS } from './project-store';
import { loadTemplates } from './templates/load';
import { detectProject } from './templates/detect';
import { saveTemplate } from './templates/save';
import { MAX_REWORK_ROUNDS } from './tickets/review';
import type { Config } from './config';
import type { BudgetService } from './budget/service';
import type { Restrictions } from './budget/restrictions';
import type { LoopService } from './budget/loop-service';
import type { Ledger } from './budget/ledger';
import type { QuotaState } from './budget/quota';
import type { SleepTimer } from './budget/sleep';
import { handleProjectsRoute, type ProjectsApi } from './projects-api';

/** Finds the project a request or socket asked for with `?project=<name>`; no name means the first project; undefined when it is not open. */
export type ProjectResolver = (name?: string) => Context | undefined;
import type { InstallService } from './prereq/install';
import type { WakeService } from './agents/wake';

export interface Context extends V1Context {
  getPort(): number;
  token: string;
  ptys: PtyManager;
  store: ProjectStore;
  projectName: string;
  projectRoot: string;
  claudeCommand: string[];
  /** Mod folder passed to launched sessions (--plugin-dir), when enabled. */
  modDir?: string;
  scheduler: Scheduler;
  reading: ReadingStore;
  /** Last launch arguments per session (a test seam; contains no secrets). */
  launchLog: Map<string, string[]>;
  /** Where rendered system-prompt files are written (under the project's .andromedacli/state). */
  promptsDir: string;
  bypass: boolean;
  language: string;
  bundles: Bundles;
  uiDist: string;
  testMode: boolean;
  configPath: string;
  /** The repositories agents can work in (see `discoverRepos`), read at each use: a repo made later is seen. */
  repos(): string[];
  /** Drops the remembered list of repositories (one was just made). */
  forgetRepos(): void;
  /** Once per repository: keeps `.andromedacli/` out of its git status and installs the release hook. Never rejects. */
  prepareRepo(path: string): Promise<void>;
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
  /** Console-wide terminals that are not agent sessions (assisted installs, Phase 6F); served on /ws/term/<id> after the project's own. */
  utilityPtys: PtyManager;
  /** Assisted installation of prerequisites: console-wide, one install at a time. */
  installer: InstallService;
  /** Wakes a dormant agent (Phase 6A). */
  wake: WakeService;
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
  /** The console's open projects (Phase 6C); set by the host, shared by every project's Context. */
  projects?: ProjectsApi;
  /** Phase 6B: unique for the whole console (6C shares it between projects). */
  notifier: Notifier;
  /** What the user is looking at, as the UI last reported it. */
  presence: Presence;
  notify: NotificationService;
  /** Read at each event. */
  readonly notificationsConfig: Config['notifications'];
  applyNotifications(n: Config['notifications']): void;
  /** The model menu (aliases plus the remote or shipped catalog) and the saved agent model (SPEC 12). */
  models: ModelCatalog;
  /** The plugin catalog, read-only (SPEC 30). */
  plugins: PluginCatalog;
  /** Makes a saved config patch live: limits, budget, git, models, plugins (the language and the bypass/guard switches go through their own setters). */
  applyConfig(config: Config, applied: Record<string, unknown>): void;
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
  const main: SessionInfo = { slug: ctx.projectName, profile: 'main', role: 'main', status: status(ctx.projectName), state: stateOf(ctx.projectName) };
  // Only sessions of this run: agents saved by an earlier run are history (resume is Phase 6) and keep their slug reserved.
  const agents: SessionInfo[] = ctx.store.listAgents()
    .filter((a) => ctx.ptys.status(a.slug) !== 'unknown' || ctx.registry.get(a.slug) !== undefined)
    .map((a) => ({ slug: a.slug, profile: a.profile, role: 'agent', status: status(a.slug), ...derived(a.slug), ...(ctx.launchWatch.stalled(a.slug) ? { launchStalled: true } : {}), ...(a.stale ? { stale: true as const } : {}), ...(ctx.loop.level(a.slug) > 0 ? { loop: ctx.loop.level(a.slug) as 1 | 2 | 3 } : {}) }));
  let testCommand: string | undefined;
  let squash: boolean | undefined;
  let offeredProfiles: string[] | undefined;
  try { ({ testCommand, squash, profiles: offeredProfiles } = ctx.store.project); } catch { /* a damaged project.json: shown as not set */ }
  const repos = ctx.repos();
  const worst = ctx.quotaState.worst();
  const slept = ctx.sleep.state();
  const installed = ctx.installer.state();
  return {
    ...(installed ? { install: installed } : {}),
    ...(worst ? { quota: { percent: worst.percent, kind: worst.kind } } : {}),
    ...(slept.phase !== 'awake' ? { sleep: { ...(slept.until !== undefined ? { until: slept.until } : {}), phase: slept.phase, attempt: slept.attempt, weekly: slept.kind === 'seven_day' } } : {}),
    // One project per console today: the stricter of the global and the per-project limit is the one that holds.
    limits: { active: ctx.scheduler.activeCount(), max: (({ global, perProject }) => Math.min(global, perProject))(ctx.scheduler.effectiveLimits()) },
    type: 'state', project: { name: ctx.projectName, ...(testCommand ? { testCommand } : {}), ...(squash !== undefined ? { squash } : {}) }, settings: { bypassPermissions: ctx.bypass, guardMode: ctx.guardMode, worktrees: ctx.git.worktrees }, main, agents, language: ctx.language, languages: [...ctx.bundles.keys()].sort(), profiles: offeredProfiles ?? PROFILES,
    prereq: ctx.getPrereq(), needsSetup: ctx.needsSetup(), projectIsRepo: repos.length > 0, repos, projectRoot: ctx.projectRoot,
    queue: ctx.questions.pending(),
    ...(ctx.projects ? { projects: ctx.projects.list() } : {}),
    notifications: { toast: ctx.notify.toast(), config: ctx.notificationsConfig },
  };
}

/** The console-wide part the request handler needs; unlike a project's Context it exists even when no project is open. */
export interface HostContext {
  getPort(): number;
  token: string;
  uiDist: string;
  /** The user's config folder (templates live under it). */
  configDir: string;
  version: string;
  bundles: Bundles;
  projects: ProjectsApi;
  ensurePrereq(): Promise<PrereqResult[]>;
  info(): HostInfo;
  /** The native "choose a folder" window (the server runs on the user's own machine). */
  pickFolder(): Promise<PickFolderResult>;
}

export function createRequestHandler(source: Context | ProjectResolver, host: HostContext) {
  const resolve: ProjectResolver = typeof source === 'function' ? source : () => source;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isAllowedHost(req.headers.host, host.getPort())) return fail(res, 403, 'forbidden');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${host.getPort()}`);
    const path = url.pathname;

    // Static UI files: no token needed, the page itself carries the token in its URL.
    const asset = req.method === 'GET' ? STATIC[path] : undefined;
    if (asset) {
      const file = join(host.uiDist, asset.file);
      if (!existsSync(file)) return fail(res, 404, 'not_found');
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
      res.end(path === '/' ? renderIndex(readFileSync(file, 'utf8'), host.version) : readFileSync(file));
      return;
    }

    // UI texts are not secret and the page needs them to explain a wrong token, so they only need the Host check.
    const i18n = /^\/i18n\/(\w+)$/.exec(path);
    if (req.method === 'GET' && i18n) {
      const payload = bundlePayload(host.bundles, i18n[1]!);
      return payload ? send(res, 200, payload) : fail(res, 404, 'not_found');
    }

    // The mod channel has its own authentication (per-session tokens); the UI token is not valid there.
    if (path.startsWith('/v1/')) {
      // The project that issued the session token is the one that answers (tokens are random, no project can use another's).
      const t = extractToken(req.headers, url);
      const owner = t ? host.projects.contexts().find((c) => c.tokens.slugFor(t) !== undefined) : undefined;
      return owner ? handleV1(owner, req, res, url) : fail(res, 401, 'unauthorized');
    }

    const token = extractToken(req.headers, url);
    if (!token || !tokensEqual(token, host.token)) return fail(res, 401, 'unauthorized');

    // Opening and closing projects are not about one project; every other route below is, and takes it from `?project=` (absent: the first).
    if ((req.method === 'POST' && path === '/api/projects') || (req.method === 'DELETE' && /^\/api\/projects\/[^/]+$/.test(path))) return handleProjectsRoute(host, req, res, path);
    // What the console knows without any project: the welcome screen asks this before anything else.
    if (req.method === 'GET' && path === '/api/host') return send(res, 200, host.info());
    if (req.method === 'POST' && path === '/api/pick-folder') {
      const picked = await host.pickFolder();
      return picked.status === 'busy' ? fail(res, 409, 'folder.pickBusy') : send(res, 200, picked);
    }
    // Project templates and project detection are project-independent (the welcome screen needs them with no project open); saving a template is not.
    if (req.method === 'GET' && path === '/api/templates') {
      return send(res, 200, loadTemplates({ configDir: host.configDir }).map((t) => ({
        id: t.id, name: t.name, description: t.description, source: t.source, valid: t.valid, ...(t.reason ? { reason: t.reason } : {}),
      })));
    }
    // What the project in a folder suggests (SPEC 21): read-only, no process is run.
    if (req.method === 'GET' && path === '/api/projects/detect') {
      const root = url.searchParams.get('root') ?? '';
      let isDir = false;
      try { isDir = isAbsolute(root) && statSync(root).isDirectory(); } catch { /* not there */ }
      if (!isDir) return fail(res, 422, 'project.badRoot');
      return send(res, 200, detectProject(resolvePath(root)));
    }
    const asked = url.searchParams.get('project');
    const projectCtx = asked !== null ? resolve(asked) : resolve();
    if (!projectCtx) return fail(res, 404, 'project.notFound');
    const ctx: Context = projectCtx;

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
      const b = (typeof body === 'object' && body !== null ? body : {}) as { slug?: unknown; profile?: unknown; repo?: unknown };
      // The UI button (a user) and the main's spawn_agent tool share one flow: validation, name reservation, limits.
      const out = await spawnAgent(ctx, { slug: String(b.slug ?? ''), profile: String(b.profile ?? ''), source: 'user', ...(typeof b.repo === 'string' ? { repo: b.repo } : {}) });
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

    // Wakes a dormant agent: the dormant panel's button, an explicit action of the user.
    const wake = /^\/api\/agents\/([a-z0-9]+(?:-[a-z0-9]+)*)\/wake$/.exec(path);
    if (req.method === 'POST' && wake) {
      const out = await ctx.wake.wake(wake[1]!, 'user');
      return out.ok ? send(res, 200, { status: out.status }) : fail(res, 409, out.code);
    }

    if (req.method === 'POST' && path === '/api/prereq/recheck') return send(res, 200, await ctx.refreshPrereq());

    // Assisted install (Phase 6F): the request names a tool, the shipped table names the command.
    const install = /^\/api\/prereq\/([a-z]+)\/install$/.exec(path);
    if (req.method === 'GET' && install) {
      const d = await ctx.installer.describe(install[1]!);
      if (d.ok) return send(res, 200, d.info);
      return d.code === 'not_found' ? fail(res, 404, 'not_found') : send(res, 200, { unavailable: d.unavailable });
    }
    if (req.method === 'POST' && install) {
      let body: unknown;
      try { body = await readBody(req); } catch { return fail(res, 400, 'bad_request'); }
      const b = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
      const out = await ctx.installer.start(install[1]!, b);
      if (!out.ok) return fail(res, out.httpStatus, out.code, out.params);
      return send(res, 202, { terminal: out.terminal });
    }
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
      // The language must have a bundle (the file check alone only knows its shape); everything else is validated against the merged file.
      if ('language' in b && (typeof b.language !== 'string' || (b.language !== 'auto' && !ctx.bundles.has(b.language)))) return fail(res, 422, 'config.invalid', { path: 'language' });
      const saved = applyConfigPatch(ctx.configPath, b);
      if (!saved.ok) return saved.code === 'config.invalid' ? fail(res, 422, saved.code, { path: saved.path }) : fail(res, 409, saved.code);
      const applied = saved.applied as { language?: string; agents?: { bypassPermissions?: boolean }; guard?: { mode?: 'enforce' | 'shadow' } };
      if (applied.language !== undefined) ctx.setLanguage(applied.language);
      if (applied.agents?.bypassPermissions !== undefined || applied.guard?.mode !== undefined) ctx.applySettings({ bypass: applied.agents?.bypassPermissions, guardMode: applied.guard?.mode });
      ctx.applyConfig(saved.config, saved.applied);
      if ((saved.applied as { notifications?: unknown }).notifications !== undefined) ctx.applyNotifications(saved.config.notifications);
      ctx.broadcastState();
      return send(res, 200, saved.applied);
    }

    // The Options dialog (SPEC 5.8): the effective configuration and the read-only facts it shows.
    if (req.method === 'GET' && path === '/api/options') {
      const { config, errors } = loadConfig(ctx.configPath);
      const dir = dirname(ctx.configPath);
      const profilesDir = join(dir, 'profiles');
      return send(res, 200, {
        config, errors, paths: { configDir: dir, profilesDir, templatesDir: join(dir, 'templates') }, server: { port: ctx.getPort() },
        profiles: PROFILES.map((name) => ({ name, source: loadProfile(name, ctx.projectRoot, profilesDir)?.source ?? null })),
        names: { minLength: SLUG_MIN, maxLength: SLUG_MAX, banned: GENERIC_WORDS },
      });
    }
    if (req.method === 'GET' && path === '/api/models') return send(res, 200, await ctx.models.list());
    if (req.method === 'POST' && path === '/api/models/refresh') return send(res, 200, await ctx.models.list(true));
    if (req.method === 'GET' && path === '/api/plugins') return send(res, 200, await ctx.plugins.list(ctx.getPrereq()?.find((r) => r.id === 'claude')?.version));
    if (req.method === 'POST' && path === '/api/plugins/refresh') return send(res, 200, await ctx.plugins.list(ctx.getPrereq()?.find((r) => r.id === 'claude')?.version, true));

    if (req.method === 'PUT' && path === '/api/project') {
      let body: unknown;
      try { body = await readBody(req); } catch { return fail(res, 400, 'bad_request'); }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail(res, 400, 'bad_request');
      const b = body as Record<string, unknown>;
      const hasCommand = 'testCommand' in b;
      const hasSquash = 'squash' in b;
      const projectFields = PROJECT_FIELDS.filter((f) => f in b); // Phase 6D: build/lint commands, profiles, model, budget, limit, docs, secrets
      if (!hasCommand && !hasSquash && projectFields.length === 0) return fail(res, 400, 'bad_request');
      // Everything is checked before anything is written: a bad entry changes nothing.
      if (hasSquash && typeof b.squash !== 'boolean') return fail(res, 422, 'project.squashInvalid');
      if (hasCommand && !isValidTestCommand(b.testCommand)) return fail(res, 422, 'project.testCommandInvalid');
      for (const f of projectFields) {
        const v = typeof b[f] === 'string' ? (b[f] as string).trim() : b[f];
        const clears = v === null || v === '' || (Array.isArray(v) && v.length === 0);
        if (!clears && !isValidProjectField(f, v, PROFILES)) return fail(res, 422, 'project.fieldInvalid', { field: f });
      }
      if (hasCommand) ctx.store.setTestCommand(b.testCommand as string);
      if (hasSquash) ctx.store.setSquash(b.squash as boolean);
      if (projectFields.length > 0) ctx.store.setFields(Object.fromEntries(projectFields.map((f) => [f, b[f]])), PROFILES);
      ctx.broadcastState();
      const saved = ctx.store.project;
      return send(res, 200, { ...(hasCommand && saved.testCommand ? { testCommand: saved.testCommand } : {}), ...(hasSquash ? { squash: b.squash } : {}), ...Object.fromEntries(projectFields.filter((f) => saved[f] !== undefined).map((f) => [f, saved[f]])) });
    }

    if (req.method === 'POST' && path === '/api/projects/save-template') {
      let body: unknown;
      try { body = await readBody(req); } catch { return fail(res, 400, 'bad_request'); }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail(res, 400, 'bad_request');
      const b = body as { id?: unknown; name?: unknown; overwrite?: unknown };
      let project;
      try { project = ctx.store.project; } catch { return fail(res, 422, 'template.invalid'); }
      const saved = saveTemplate({ projectRoot: ctx.projectRoot, project, configDir: dirname(ctx.configPath), id: String(b.id ?? ''), name: b.name, overwrite: b.overwrite === true });
      if (!saved.ok) return fail(res, saved.code === 'template.exists' ? 409 : 422, saved.code);
      return send(res, 201, { id: String(b.id) });
    }

    // Changes the template of the open project: the profiles, main.md and rules.md of the new one replace the files of the same name; the
    // commands already set stay (what the user typed beats the template's).
    if (req.method === 'POST' && path === '/api/projects/apply-template') {
      let body: unknown;
      try { body = await readBody(req); } catch { return fail(res, 400, 'bad_request'); }
      if (typeof body !== 'object' || body === null || Array.isArray(body) || typeof (body as { templateId?: unknown }).templateId !== 'string') return fail(res, 400, 'bad_request');
      let current;
      try { current = ctx.store.project; } catch { return fail(res, 422, 'template.invalid'); }
      const { applyTemplate } = await import('./templates/apply');
      const done = await applyTemplate({
        templateId: (body as { templateId: string }).templateId, root: ctx.projectRoot, name: ctx.projectName, create: false,
        build: current.buildCommand, test: current.testCommand, lint: current.lintCommand, configDir: dirname(ctx.configPath),
      });
      if (!done.ok) return fail(res, 422, done.code);
      ctx.broadcastState();
      return send(res, 200, { templateId: (body as { templateId: string }).templateId });
    }

    // Makes the project folder a git repository (`git init -b main` and an empty first commit). Refused when it already is, or holds repositories.
    if (req.method === 'POST' && path === '/api/projects/git-init') {
      if (ctx.repos().length > 0) return fail(res, 409, 'git.alreadyRepo');
      const { initRepo } = await import('./templates/apply');
      const made = await initRepo(ctx.projectRoot);
      if (!made.ok) return fail(res, 422, made.code, made.detail ? { reason: made.detail } : undefined);
      ctx.forgetRepos();
      await ctx.prepareRepo(ctx.projectRoot); // keeps .andromedacli/ out of the new repository's status
      ctx.broadcastState();
      return send(res, 200, { ok: true });
    }

    return fail(res, 404, 'not_found');
  };
}
