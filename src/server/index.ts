import http from 'node:http';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRequestHandler, type Context } from './http';
import { attachWebSockets } from './ws';
import { loadBundles } from './i18n-bundles';
import { loadConfig } from './config';
import { PlanStore } from './plan-store';
import { PtyManager } from './pty/pty-manager';
import { buildClaudeLaunch } from './pty/claude-launch';
import { createToken, SessionTokens } from './security';
import { AgentRegistry } from './agents/registry';
import { Inbox } from './agents/inbox';
import { Scheduler } from './agents/scheduler';
import { QuestionQueue } from './questions/queue';
import { ReadingStore } from './reading/store';
import { failQueuedStart, launchAgent, spawnAgent } from './agents/spawn';
import { TicketStore } from './tickets/store';
import { StepService } from './tickets/steps';
import { LaunchWatch } from './agents/launch-watch';
import { evaluate } from './guard/rules';
import { excludeConsoleFolder } from './git/worktree';
import { GuardLog } from './guard/log';
import { languageName, renderMainPrompt } from './profiles';
import { runChecks, type Runner } from './prereq/checks';
import type { PrereqResult } from '../shared/protocol';

export interface StartOptions {
  port: number;
  planRoot: string;
  configDir: string;
  planName: string;
  /** Folder with messages_<lang>.properties (default: the shipped ones; tests). */
  i18nDir?: string;
  claudeCommand?: string[];
  /** Folder of the console mod. Default: the shipped one when `mod.enabled`; `null` launches sessions without the mod. */
  modDir?: string | null;
  /** Injectable command runner for the prerequisite checks (tests). */
  prereqRunner?: Runner;
  /** How long after a launch the console checks that the agent started and took its goal (default 90 s; tests use less). */
  launchCheckMs?: number;
  /** Overrides `git.worktrees` from the configuration (embedding and tests: agents share the plan folder when false). */
  worktrees?: boolean;
  /** A test seam: runs once an agent's worktree exists, before its process starts; a throw simulates a failed start. */
  afterWorktreeCreated?: (slug: string) => void | Promise<void>;
}
export interface RunningServer {
  port: number;
  address: string;
  token: string;
  url: string;
  /** Token a launched session uses on /v1 (tests and in-process callers). */
  sessionTokenFor(slug: string): string | undefined;
  /** Queues a message for a session; the mod delivers it as a new turn. Returns the message id. */
  sendMessage(slug: string, text: string): string;
  writeToSession(slug: string, data: string): void;
  /** Changes the active-agent limits at runtime (SPEC 16.7); running agents are never stopped. */
  setLimits(l: { global: number; perPlan: number }): void;
  /** Arguments the session was launched with (a test seam). */
  lastLaunchArgs(slug: string): string[] | undefined;
  close(): Promise<void>;
}

/** Starts the console: one HTTP+WebSocket server on 127.0.0.1, the plan store and the main session. */
export async function startServer(o: StartOptions): Promise<RunningServer> {
  const configPath = join(o.configDir, 'config.json');
  const { config } = loadConfig(configPath);
  const store = new PlanStore(o.planRoot);
  store.init(o.planName);
  // The plan keeps the name it was created with, even if its folder is renamed later (it is also the main session id).
  const planName = store.plan.name;
  const ptys = new PtyManager();
  const token = createToken();
  const tokens = new SessionTokens();
  const inbox = new Inbox();
  const registry = new AgentRegistry();
  registry.register({ slug: planName, role: 'main', profile: 'main' });
  const questions = new QuestionQueue();
  const reading = new ReadingStore(join(o.planRoot, '.console', 'state', 'reading'));
  const limits = { global: config.agents.maxActiveGlobal, perPlan: config.agents.maxActivePerPlan };
  // Settings read when a session is launched: a change applies to the sessions started afterwards, never to running ones.
  const runtime = { bypass: config.agents.bypassPermissions, guardMode: config.guard.mode, git: { ...config.git, ...(o.worktrees !== undefined ? { worktrees: o.worktrees } : {}) } };
  // The guard mode a session was launched under: a later change in Settings does not reach sessions already running.
  const sessionGuardMode = new Map<string, 'enforce' | 'shadow'>([[planName, config.guard.mode]]);
  const launchWatch = new LaunchWatch({ registry, delayMs: () => o.launchCheckMs ?? 90_000, notifyMain: (text) => { inbox.push(planName, text); broadcast(); } });
  const guardLog = new GuardLog(join(o.planRoot, '.console', 'state', 'guard.jsonl'));
  const tickets = new TicketStore(o.planRoot);
  const steps = new StepService({
    tickets, plan: planName,
    worktreeOf: (slug) => registry.get(slug)?.git,
    testCommand: () => store.plan.testCommand,
    testTimeoutMs: () => runtime.git.testTimeoutMinutes * 60_000,
    secretPatterns: () => runtime.git.secretPatterns,
    notifyMain: (_slug, text) => { inbox.push(planName, text); },
    changed: () => broadcast(),
  });
  const launchLog = new Map<string, string[]>();
  // The scheduler's callbacks reach `ctx` (defined below) lazily, only once the server is running.
  const scheduler = new Scheduler({
    registry, limits: () => limits,
    start: (r) => launchAgent(ctx, r),
    onStartError: (r) => failQueuedStart(ctx, r),
  });
  let port = 0;
  let broadcast = () => {};
  let prereq: PrereqResult[] | null = null;
  let language: string = config.language;
  const refreshPrereq = async (): Promise<PrereqResult[]> => {
    // The Claude check runs the configured command (not the test override), so a custom install is judged fairly.
    prereq = await runChecks(o.prereqRunner, { claudeCommand: config.claude.command });
    broadcast();
    return prereq;
  };
  let startupChecks: Promise<PrereqResult[]> | undefined;
  let planIsRepo = false;
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: o.planRoot, stdio: 'ignore', timeout: 5000 });
    planIsRepo = true;
  } catch { /* not a repository, or git is missing: the checks report the latter */ }
  // The console's own folder never shows up in the project's git status (kept in .git/info/exclude, not in its .gitignore).
  if (planIsRepo) await excludeConsoleFolder(o.planRoot).catch(() => { /* cosmetic: the first worktree tries again */ });

  const ctx: Context = {
    getPort: () => port,
    token, ptys, store, tokens, inbox, registry, scheduler, launchLog, questions, reading, tickets, steps, launchWatch,
    afterWorktreeCreated: o.afterWorktreeCreated,
    get git() { return runtime.git; },
    get guardMode() { return runtime.guardMode; },
    modDir: o.modDir === null ? undefined : (o.modDir ?? (config.mod.enabled ? resolve(import.meta.dirname, '..', '..', 'mod') : undefined)),
    promptsDir: join(o.planRoot, '.console', 'state', 'prompts'),
    guard: (slug, tool, input) => {
      const rt = registry.get(slug);
      const role = rt?.role ?? 'agent';
      // The judge is the caller's own worktree and role, taken from its session: nothing in the request body can change them.
      const verdict = evaluate({ role, tool, input }, {
        worktree: role === 'agent' && rt?.git ? rt.git.worktree : o.planRoot, repo: o.planRoot,
        branch: rt?.git?.branch ?? '', planBranch: `plan/${planName}`, secretPatterns: runtime.git.secretPatterns,
      });
      if (verdict.decision === 'allow') return verdict;
      const mode = sessionGuardMode.get(slug) ?? runtime.guardMode;
      const shadow = mode === 'shadow';
      const detail = [input.command, input.file_path, input.notebook_path, input.path].find((v): v is string => typeof v === 'string') ?? '';
      guardLog.append({ slug, role, tool, rule: verdict.rule, reason: verdict.reason, mode, outcome: shadow ? 'shadow-allowed' : 'denied', detail });
      return shadow ? { decision: 'allow' } : verdict;
    },
    handleModEvent: (slug, e) => {
      // The turn ended: a question its tool call was waiting on (for example an aborted turn) has no asker any more.
      if (e.type === 'turn.complete') questions.dropFrom(slug);
      registry.onModEvent(slug, e);
      // The assistant's final text of a turn feeds the "read" panel (never read from the terminal).
      if (e.type === 'turn.complete' && typeof e.data?.answer === 'string') reading.add(slug, e.data.answer);
    },
    tools: {
      list_agents: async () => ({
        agents: registry.list().map((a) => ({
          slug: a.slug, profile: a.profile, role: a.role, state: a.state,
          ...(a.goal ? { goal: a.goal.length > 300 ? `${a.goal.slice(0, 300)}…` : a.goal } : {}),
          ...(a.state === 'queued' ? { queuedPosition: scheduler.position(a.slug) } : {}),
        })),
      }),
      ask_user: async (slug, body) => {
        const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
        if (typeof b.question !== 'string' || b.question.trim() === '') return { status: 'error', code: 'bad_request' };
        const options = Array.isArray(b.options) ? b.options.filter((o): o is string => typeof o === 'string').slice(0, 8).map((o) => o.slice(0, 200)) : undefined;
        return questions.ask({
          from: slug, text: b.question, options: options && options.length > 0 ? options : undefined, multiSelect: b.multiSelect === true,
          kind: b.kind === 'permission' ? 'permission' : 'question',
          tool: typeof b.tool === 'string' ? b.tool : undefined, detail: typeof b.detail === 'string' ? b.detail : undefined,
        });
      },
      checklist_set: async (slug, body) => {
        const items = (body as { items?: unknown } | null)?.items;
        if (!Array.isArray(items)) return { status: 'error', code: 'bad_request' };
        return steps.checklistSet(slug, items as string[]);
      },
      step_done: async (slug, body) => {
        const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
        if (typeof b.n !== 'number' || !Number.isInteger(b.n)) return { status: 'error', code: 'bad_request' };
        return steps.stepDone(slug, {
          n: b.n, note: typeof b.note === 'string' ? b.note : undefined, skip: b.skip === true,
        });
      },
      report_blocked: async (slug, body) => {
        const reason = (body as { reason?: unknown } | null)?.reason;
        if (typeof reason !== 'string' || reason.trim() === '') return { status: 'error', code: 'bad_request' };
        steps.reportBlocked(slug, reason.trim().slice(0, 500));
        return { status: 'ok' };
      },
      spawn_agent: async (_slug, body) => {
        const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
        if (typeof b.name !== 'string' || typeof b.profile !== 'string' || typeof b.goal !== 'string' || b.goal.trim() === '') {
          return { status: 'error', code: 'bad_request' };
        }
        const out = await spawnAgent(ctx, { slug: b.name, profile: b.profile, goal: b.goal, model: typeof b.model === 'string' ? b.model : undefined, source: 'main' });
        if (!out.ok) return { status: 'error', code: out.code, ...(out.params ? { params: out.params } : {}) };
        return out.status === 'started' ? { status: 'started', name: out.slug } : { status: 'queued', name: out.slug, position: out.position };
      },
    },
    planName,
    planRoot: o.planRoot,
    claudeCommand: o.claudeCommand ?? config.claude.command,
    get bypass() { return runtime.bypass; },
    get language() { return language; },
    bundles: loadBundles(o.i18nDir),
    uiDist: resolve(import.meta.dirname, '..', '..', 'dist', 'ui'),
    testMode: process.env.CONSOLE_TEST === '1',
    configPath,
    planIsRepo,
    getPrereq: () => prereq,
    ensurePrereq: () => prereq ? Promise.resolve(prereq) : (startupChecks ??= refreshPrereq()),
    refreshPrereq,
    setLanguage: (l) => { language = l; },
    applySettings: (s) => {
      if (s.bypass !== undefined) runtime.bypass = s.bypass;
      if (s.guardMode !== undefined) runtime.guardMode = s.guardMode;
    },
    noteLaunch: (slug) => {
      sessionGuardMode.set(slug, runtime.guardMode);
      return { bypass: runtime.bypass };
    },
    needsSetup: () => !existsSync(configPath),
    broadcastState: () => broadcast(),
  };

  const server = http.createServer((req, res) => {
    void createRequestHandler(ctx)(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'internal' }));
    });
  });
  const ws = attachWebSockets(server, ctx);
  broadcast = ws.broadcastState;
  reading.on((slug, entry) => ws.broadcastJson({ type: 'reading', slug, entry }));

  await new Promise<void>((ok, err) => {
    server.once('error', err);
    server.listen(o.port, '127.0.0.1', () => ok()); // never another interface (SPEC 4.5)
  });
  const addr = server.address() as AddressInfo;
  port = addr.port;
  const url = `http://127.0.0.1:${port}`;

  registry.on(() => broadcast());
  // A session waits for the user exactly while it has an open question.
  questions.onChange(() => {
    for (const a of registry.list()) registry.setWaitingUser(a.slug, questions.hasPending(a.slug));
    broadcast();
  });
  ptys.onExit((id) => {
    questions.dropFrom(id);
    registry.onProcessExit(id);
    tokens.revoke(id);
    inbox.clear(id);
    broadcast();
  });
  startupChecks = refreshPrereq(); // background; unknown is null in the state and agent creation waits for it
  const launch = buildClaudeLaunch({
    command: ctx.claudeCommand, role: 'main', slug: planName, plan: planName,
    url, token: tokens.issue(planName), bypass: ctx.bypass, baseEnv: process.env,
    pluginDir: ctx.modDir,
    allowedTools: ctx.modDir ? ['mcp__console-mod__spawn_agent', 'mcp__console-mod__list_agents', 'mcp__console-mod__ask_user'] : undefined,
    appendPromptFile: renderMainPrompt({ plan: planName, workLanguage: languageName(config.language), outDir: ctx.promptsDir }),
  });
  ptys.spawn({ id: planName, ...launch, cwd: resolve(o.planRoot), cols: 120, rows: 30 });

  return {
    port, address: addr.address, token, url,
    sessionTokenFor: (slug) => tokens.tokenFor(slug),
    sendMessage: (slug, text) => inbox.push(slug, text),
    writeToSession: (slug, data) => ptys.write(slug, data),
    setLimits: (l) => { limits.global = l.global; limits.perPlan = l.perPlan; scheduler.release(); },
    lastLaunchArgs: (slug) => launchLog.get(slug),
    close: async () => {
      launchWatch.close();
      scheduler.close(); // before killing: exiting processes would otherwise free slots and start queued agents
      await ptys.killAll();
      ws.closeAll();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
