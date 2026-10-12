import http from 'node:http';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRequestHandler, type Context, type HostContext } from './http';
import { attachWebSockets } from './ws';
import { loadBundles, type Bundles } from './i18n-bundles';
import { loadConfig, type Config } from './config';
import { PROJECT_NAME_RE, ProjectError, type AddProjectOptions, type ProjectsApi } from './projects-api';
import { projectNameFromDir } from './cli-args';
import { ModelCatalog } from './catalog/models';
import { PluginCatalog } from './catalog/plugins';
import { ProjectStore } from './project-store';
import { PtyManager } from './pty/pty-manager';
import { hardenExecutableSearch } from './exe-search';
import { installProcessGuards } from './crash-log';
import { detectProject } from './templates/detect';
import { createToken, LoginCodes } from './security';
import { describeKey } from './questions/describe';
import { appRoot, resourcePath } from './paths';
import { UiAssets } from './ui-assets';
import type { UpdateControl } from '../shared/update';
import { spawnAgent } from './agents/spawn';
import { TestQueue } from './tickets/test-queue';
import { createTranslator } from '../shared/i18n';
import { resolveVersion } from './version';
import { evaluate } from './guard/rules';
import { repoPathOf } from './git/repos';
import { GuardLog } from './guard/log';
import { HelperUsage, type HelperUse } from './helper-usage';
import { runChecks, type Runner } from './prereq/checks';
import type { ProjectTab, PrereqResult } from '../shared/protocol';
import { Ledger } from './budget/ledger';
import { QuotaState } from './budget/quota';
import { SleepTimer, type SleepClock, type SleepState } from './budget/sleep';
import { writeJsonAtomic } from './fs-atomic';
import { InstallService, type InstallEntry } from './prereq/install';
import { NullNotifier, ToastNotifier, type Notifier } from './notify/notifier';
import { Presence } from './notify/presence';
import { NotificationService, realNotifyClock, type NotifyClock } from './notify/service';
import { renderRestartNotice, restoreAgents } from './agents/restore';
import { createFolderPicker, type PickFolderResult } from './pick-folder';
import { cleanupWorktree } from './git/cleanup';
import { readJsonFile } from './json-file';
import { errorMessage } from '../shared/guards';
import { Container } from './runtime/container';
import type { Services, ProjectContainer } from './runtime/services';
import { registerState } from './runtime/state';
import { registerTests } from './runtime/tests';
import { registerAgents } from './runtime/agents';
import { registerTicketFlow } from './runtime/ticket-flow';
import { registerBudget, WAKE_MESSAGE } from './runtime/budget';
import type { Shared, ProjectRuntime } from './runtime/types';
export type { ProjectRuntime } from './runtime/types';

export interface StartOptions {
  port: number;
  /** The project folder to open first. Absent: only the projects remembered in `<configDir>/projects.json` are opened (possibly none: the welcome screen). */
  projectRoot?: string;
  configDir: string;
  projectName?: string;
  /** A test seam: replaces the native "choose a folder" window. */
  pickFolder?: () => Promise<PickFolderResult>;
  /** The desktop app's update control (SPEC 33.4); absent when the console runs from a terminal. */
  updates?: UpdateControl;
  /** A test seam: replaces the network call to Groq of the voice dictation. */
  groqFetch?: typeof fetch;
  /** Folder with messages_<lang>.properties (default: the shipped ones; tests). */
  i18nDir?: string;
  claudeCommand?: string[];
  /** Folder of the console mod. Default: the shipped one when `mod.enabled`; `null` launches sessions without the mod. */
  modDir?: string | null;
  /** Injectable command runner for the prerequisite checks (tests). */
  prereqRunner?: Runner;
  /** Build version override (tests); default: the latest tag on main of the console's own repository. */
  version?: string;
  /** How long after a launch the console checks that the agent started and took its goal (default 90 s; tests use less). */
  launchCheckMs?: number;
  /** Overrides `git.worktrees` from the configuration (embedding and tests: agents share the project folder when false). */
  worktrees?: boolean;
  /** A test seam: runs once an agent's worktree exists, before its process starts; a throw simulates a failed start. */
  afterWorktreeCreated?: (slug: string) => void | Promise<void>;
  /** Where Claude Code keeps its transcripts (default `~/.claude/projects`, or `$CLAUDE_CONFIG_DIR/projects`); tests use a temp folder. */
  projectsDir?: string;
  /** How often the budget grace period is checked without a turn (default 30 s; tests use less). */
  tickMs?: number;
  /** A test seam: the clock of the requests between agents (the timeout is counted on it). */
  requestNow?: () => number;
  /** A test seam: the clock of the sleep timer (the real one is used by default). */
  sleepClock?: SleepClock;
  /** A test seam: replaces the shipped table of installable tools (Phase 6F), so a test runs a trivial command instead of winget. */
  installTable?: readonly InstallEntry[];
  /** A test seam: the runner that probes for winget/npm before an install is offered. */
  installRunner?: Runner;
  /** A test seam: what raises the toasts (default: the native toast, or nothing under tests). */
  notifier?: Notifier;
  /** A test seam: the clock of the notification grouping and quiet hours. */
  notifyClock?: NotifyClock;
}
export interface RunningServer {
  port: number;
  address: string;
  token: string;
  url: string;
  /** The address that opens the page: it carries a new single-use code, never the token. */
  loginUrl(): string;
  /** Token a launched session uses on /v1 (tests and in-process callers). */
  sessionTokenFor(slug: string): string | undefined;
  /** Queues a message for a session; the mod delivers it as a new turn. Returns the message id. */
  sendMessage(slug: string, text: string): string;
  writeToSession(slug: string, data: string): void;
  /** Changes the active-agent limits at runtime (SPEC 16.7); running agents are never stopped. */
  setLimits(l: { global: number; perProject: number }): void;
  /** Changes the token budget of an agent's ticket (a test seam, like `setLimits`); the step is recomputed from the usage. */
  setBudgetLimit(slug: string, limit: number): void;
  /** Arguments the session was launched with (a test seam). */
  lastLaunchArgs(slug: string): string[] | undefined;
  /** Opens another project (Phase 6C), as `POST /api/projects` does; refuses with a `ProjectError`. */
  addProject(root: string, name?: string): Promise<{ name: string }>;
  /** Closes a project (its sessions end; nothing is deleted on disk); refused for the last open project. */
  closeProject(name: string, purge?: boolean): Promise<void>;
  /** The open projects, in the order they were opened. */
  projects(): ProjectTab[];
  /** Agent sessions (not the mains) whose process is running, over every project: the desktop app asks before closing with any. */
  runningAgentCount(): number;
  close(): Promise<void>;
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The one message the main gets when a usage limit resets (SPEC 18.4). */
export { WAKE_MESSAGE };
/** How long one step_done request waits for the step (the validation can take tens of minutes): the host cuts a request that stays open for about a minute. */
const STEP_DONE_WAIT_MS = 15_000;

/** The per-project part of the console: everything bound to one folder (Phase 6C: a project runtime; `startServer` hosts the first one). */
async function createProjectRuntime(shared: Shared, p: { projectRoot: string; projectName: string }): Promise<ProjectRuntime> {
  // The old single-project code below reads `o.projectRoot` and `o.projectName`: here they are this project's.
  const o: StartOptions & { projectRoot: string; projectName: string } = { ...shared.o, projectRoot: p.projectRoot, projectName: p.projectName };
  const { configPath, config, token, bundles, ledger, quotaState, sleep, sleepClock, runtime, limits } = shared;
  const c: ProjectContainer = new Container<Services>();
  c.provide('env', () => ({ shared, o, configPath, config, token, bundles, ledger, quotaState, sleep, sleepClock, runtime, limits }));
  registerState(c);
  registerTests(c);
  registerAgents(c);
  registerTicketFlow(c);
  registerBudget(c);
  const stateProblems = c.get('stateProblems');
  const store = c.get('store');
  const previousRunWasClean = c.get('previousRunWasClean');
  const projectName = c.get('projectName');
  const ptys = c.get('ptys');
  const tokens = c.get('tokens');
  const inbox = c.get('inbox');
  const registry = c.get('registry');
  const mainResumeId = c.get('mainResumeId')();
  const questions = c.get('questions');
  const permissions = c.get('permissions');
  const reading = c.get('reading');
  // `limits` and `runtime` (the settings read when a session is launched) are console-wide: see `shared`.
  const secretPatterns = c.get('secretPatterns');
  // The guard mode a session was launched under: a later change in Settings does not reach sessions already running.
  const detectedTestCommand = c.get('detectedTestCommand');
  const testsDisabled = c.get('testsDisabled');
  const testCommandAt = c.get('testCommandAt');
  const testRunnerAt = c.get('testRunnerAt');
  const sessionGuardMode = c.get('sessionGuardMode');
  const tickets = c.get('tickets');
  const launchWatch = c.get('launchWatch');
  const endTimers = c.get('endTimers');
  const endReadOnlySession = c.get('endReadOnlySession');
  const repoOfTicket = c.get('repoOfTicket');
  const reportLanguage = c.get('reportLanguage');
  const ticketQueue = c.get('ticketQueue'); // one queue per ticket, shared by every service that changes it
  const review = c.get('review');
  const central = c.get('central');
  const merge = c.get('merge');
  const release = c.get('release');
  const finishAgent = c.get('finishAgent');
  const readHandover = c.get('readHandover');
  const keepHandover = c.get('keepHandover');
  // Token budgets (SPEC 16): usage from the Claude Code transcript, recorded in the monthly ledger, steps on the ticket.
  const restrictions = c.get('restrictions');
  const turns = c.get('turns');
  const budget = c.get('budget');
  const recovery = c.get('recovery');
  const onBudgetAnswer = c.get('onBudgetAnswer');
  const loop = c.get('loop');
  const quotaWaiters = c.get('quotaWaiters');
  const wakeTimers = c.get('wakeTimers');
  const wakeMain = c.get('wakeMain');
  const weeklyNotice = c.get('weeklyNotice');
  const ticketStatusOf = c.get('ticketStatusOf');
  const quota = c.get('quota');
  const resumedAwaitingStart = c.get('resumedAwaitingStart');
  const resumer = c.get('resumer');
  const waker = c.get('waker');
  inbox.onPush((slug) => waker.onWork(slug));
  // Messages and state kept for the next start (Phase 6A).
  const persister = c.get('persister');
  // The state is rebuilt on every push to the UI and discovery spawns git: a few seconds of memory is plenty (a repo made later shows up soon).
  const repos = c.get('repos');
  const forgetRepos = c.get('forgetRepos');
  const prepareRepo = c.get('prepareRepo');
  const staleChecker = c.get('staleChecker');
  const guardLog = new GuardLog(join(o.projectRoot, '.andromedaconsole', 'state', 'guard.jsonl'));
  const steps = c.get('steps');
  // Requests between agents (SPEC 10). Persisted per project: a restart keeps ids, deadlines and the waiting steps.
  const requestStore = c.get('requestStore');
  const requests = c.get('requests');
  inbox.onAck((slug, id) => requests.onDelivered(slug, id));
  const launchLog = c.get('launchLog');
  const scheduler = c.get('scheduler');
  const launchMain = c.get('launchMain');
  // The port, the prerequisite checks and the language are console-wide (see `shared`); any change pushes to every UI socket.
  const broadcast = (): void => shared.broadcastAll();
  for (const rel of repos()) await prepareRepo(repoPathOf(o.projectRoot, rel));

  // Notifications (SPEC 20): the server raises a native toast for what needs the user, also with the browser closed.
  const notifyClock = o.notifyClock ?? realNotifyClock;
  const notifier: Notifier = o.notifier ?? (process.env.CONSOLE_TEST === '1' || process.env.VITEST ? new NullNotifier() : new ToastNotifier());
  const presence = new Presence(() => notifyClock.now());
  const notify = new NotificationService({
    config: () => config.notifications, notifier, presence, clock: notifyClock,
    translate: () => reportLanguage().t,
    clickUrl: (itemId) => `http://127.0.0.1:${shared.getPort()}/?code=${shared.loginCode()}&project=${encodeURIComponent(projectName)}${itemId ? `#queue=${encodeURIComponent(itemId)}` : ''}`,
    isPending: (id) => questions.pending().some((q) => q.id === id),
    pushBrowser: (m) => shared.pushToProject(projectName, m),
    changed: () => broadcast(),
  });

  const ctx: Context = {
    getPort: () => shared.getPort(),
    utilityPtys: shared.utilityPtys, installer: shared.installer, update: () => o.updates?.state(),
    notifier, presence, notify,
    get notificationsConfig() { return config.notifications; },
    applyNotifications: (n) => { config.notifications = n; },
    version: o.version ?? resolveVersion(appRoot()),
    testPosition: (slug) => shared.testQueue.position(slug),
    testQueue: () => shared.testQueue.snapshot(),
    stateProblems,
    token, ptys, store, tokens, inbox, registry, scheduler, launchLog, questions, reading, tickets, steps, requests, launchWatch, review, recovery,
    budget, restrictions, loop, ledger, quotaState, sleep, wake: waker,
    afterWorktreeCreated: o.afterWorktreeCreated,
    get git() { return runtime.git; },
    get budgetConfig() { return config.budget; },
    get guardMode() { return runtime.guardMode; },
    detectedTestCommand,
    modDir: o.modDir === null ? undefined : (o.modDir ?? (config.mod.enabled ? resourcePath('mod') : undefined)),
    promptsDir: join(o.projectRoot, '.andromedaconsole', 'state', 'prompts'),
    guard: (slug, tool, input) => {
      // Which optional helpers the shell commands use (only counters are kept): the Prerequisites tab shows whether they are used.
      if ((tool === 'Bash' || tool === 'PowerShell') && typeof input.command === 'string') shared.helperUsage.record(input.command);
      const rt = registry.get(slug);
      const role = rt?.role ?? 'agent';
      // The judge is the caller's own worktree and role, taken from its session: nothing in the request body can change them.
      const verdict = evaluate({ role: role === 'main' ? 'main' : 'agent', tool, input }, {
        readOnly: rt?.readOnly === true,
        worktree: role !== 'main' && rt?.git ? rt.git.worktree : o.projectRoot, repo: o.projectRoot,
        branch: rt?.git?.branch ?? '', projectBranch: `project/${projectName}`, secretPatterns: secretPatterns(),
        restricted: restrictions.get(slug),
      });
      if (verdict.decision === 'allow') return verdict;
      const mode = sessionGuardMode.get(slug) ?? runtime.guardMode;
      const shadow = mode === 'shadow';
      const detail = [input.command, input.file_path, input.notebook_path, input.path].find((v): v is string => typeof v === 'string') ?? '';
      guardLog.append({ slug, role: role === 'main' ? 'main' : 'agent', tool, rule: verdict.rule, reason: verdict.reason, mode, outcome: shadow ? 'shadow-allowed' : 'denied', detail });
      return shadow ? { decision: 'allow' } : verdict;
    },
    afterTool: () => broadcast(),
    // A guard question or a console tool call is a sign of life too: a long turn without events is not a silence.
    activity: (slug) => { const role = registry.get(slug)?.role; if (role !== undefined && role !== 'main') { loop.detector.onModEvent(slug); refreshSilence(); } },
    handleModEvent: (slug, e) => {
      // The account's limits are not agent activity: they never reach the registry nor reset the loop detector's silence. Never awaited.
      if (e.type === 'quota') {
        // One reading of the account's limits for every project: each project's service applies the steps to its own agents.
        for (const r of shared.runtimes) r.onQuota(e.data?.rateLimits);
        return;
      }
      if (e.type === 'session.start') resumedAwaitingStart.delete(slug);
      // The turn ended: a question its tool call was waiting on (for example an aborted turn) has no asker any more.
      if (e.type === 'turn.complete') { questions.dropFrom(slug); permissions.forgetPending(slug); }
      // A sign of life ends a silence before the registry's change is broadcast, or the panel would show the old silence (SPEC 32.2).
      if (registry.get(slug) !== undefined && registry.get(slug)?.role !== 'main') loop.detector.onModEvent(slug);
      registry.onModEvent(slug, e);
      // The assistant's final text of a turn feeds the "read" panel (never read from the terminal).
      if (e.type === 'turn.complete' && typeof e.data?.answer === 'string') reading.add(slug, e.data.answer);
      if (e.type === 'turn.start') turns.set(slug, (turns.get(slug) ?? 0) + 1);
      const isAgent = registry.get(slug)?.role === 'agent';
      // The budget reads the transcript after each turn, and the loop detector looks at the events it read. Never awaited: the mod must not wait for the console.
      if (e.type === 'turn.complete' && isAgent) {
        void (async () => {
          const events = await budget.onTurnComplete(slug, { sessionId: e.sessionId, turn: turns.get(slug) ?? 0 });
          await loop.onEvents(slug, events);
          broadcast();
        })().catch((err) => budget.reportFailure(slug, err));
      }
    },
    tools: {
      list_agents: async (caller) => {
        // The main also sees what only it can settle (escalated requests, questions to it): a restart or a lost message forgets nothing.
        const held = caller === projectName ? requests.forMain() : [];
        return {
          agents: registry.list().map((a) => ({
            slug: a.slug, profile: a.profile, role: a.role, state: a.state,
            ...(a.goal ? { goal: a.goal.length > 300 ? `${a.goal.slice(0, 300)}…` : a.goal } : {}),
            ...(a.state === 'queued' ? { queuedPosition: scheduler.position(a.slug) } : {}),
            // Where the ticket is when it is not simply being written (suspended, delivered...): the main decides what to resume from it.
            ...(() => { const t = a.role === 'agent' ? ticketStatusOf(a.slug) : undefined; return t && t !== 'in_progress' ? { ticket: t } : {}; })(),
          })),
          ...(held.length > 0 ? { requests: held } : {}),
        };
      },
      resume_agent: async (_slug, body) => {
        const names = (body as { names?: unknown } | null)?.names;
        if (!Array.isArray(names) || names.length === 0 || names.length > 50 || !names.every((n): n is string => typeof n === 'string' && n !== '')) {
          return { status: 'error', code: 'bad_request' };
        }
        return resumer.resume(names);
      },
      // Phase 6A, SPEC 9.9: the console saves the work, pushes the branch and only then removes the folder; never a branch.
      worktree_cleanup: async (_slug, body) => {
        const b = (typeof body === 'object' && body !== null ? body : {}) as { name?: unknown; action?: unknown };
        if (typeof b.name !== 'string' || b.name === '' || b.action !== 'remove') return { status: 'error', code: 'bad_request' };
        return cleanupWorktree({
          repo: registry.get(b.name)?.git?.repo ?? resolve(o.projectRoot), project: projectName, secretPatterns: secretPatterns(),
          agentGit: (s) => (registry.get(s)?.role === 'agent' ? registry.get(s)?.git : undefined),
          // A running agent, one waiting for a slot, or one under review (its branch must not move) is never touched.
          isActive: (s) => ptys.status(s) === 'running' || registry.get(s)?.state === 'queued' || ticketStatusOf(s) === 'in_review',
          removed: (s) => { registry.setGit(s, undefined); store.updateAgent(s, { worktree: undefined, stale: undefined }); broadcast(); },
        }, b.name);
      },
      ask_user: async (slug, body) => {
        const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
        if (typeof b.question !== 'string' || b.question.trim() === '') return { status: 'error', code: 'bad_request' };
        const options = Array.isArray(b.options) ? b.options.filter((o): o is string => typeof o === 'string').slice(0, 8).map((o) => o.slice(0, 200)) : undefined;
        const permission = b.kind === 'permission';
        const tool = typeof b.tool === 'string' ? b.tool : '';
        // The whole input as the mod saw it ("always" is exact). No key (the input was too long to keep): never remembered.
        const key = typeof b.key === 'string' ? b.key : '';
        // What the user is shown is built here from that key, so it is the call that gets remembered, not a text the client chose.
        const detail = (key !== '' ? describeKey(key) : undefined) ?? (typeof b.detail === 'string' ? b.detail : '');
        // SPEC 32.3: an "always" answer given earlier for this exact call is answered at once, never shown (the guard still runs separately).
        const known = permission ? permissions.recall(slug, tool, key) : undefined;
        if (known) return questions.answerNow({ from: slug }, known);
        let askedId = '';
        const asked = questions.ask({
          from: slug, text: b.question, options: options && options.length > 0 ? options : undefined, multiSelect: b.multiSelect === true,
          kind: permission ? 'permission' : 'question',
          tool: tool || undefined, detail: detail || undefined, canRemember: key.trim() !== '',
        }, permission ? (answer) => {
          permissions.untrack(askedId);
          const verdict = answer === 'allow_always' ? 'allow' : answer === 'deny_always' ? 'deny' : undefined;
          if (!verdict) return;
          permissions.remember(slug, tool, key, verdict);
          // Identical requests of the same agent already waiting (parallel tool calls) get the same answer.
          for (const sibling of permissions.siblings(slug, tool, key, askedId)) { permissions.untrack(sibling); questions.answer(sibling, verdict); }
        } : undefined);
        askedId = asked.id;
        if (permission) permissions.track(asked.id, slug, tool, key);
        return asked;
      },
      checklist_set: async (slug, body) => {
        const items = (body as { items?: unknown } | null)?.items;
        if (!Array.isArray(items)) return { status: 'error', code: 'bad_request' };
        // A restricted agent may only close its step: a new checklist would let it escape the restriction with an empty step.
        if (restrictions.get(slug)) return { status: 'refused', code: 'restricted' };
        return steps.checklistSet(slug, items as string[]);
      },
      step_done: async (slug, body) => {
        const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
        if (typeof b.n !== 'number' || !Number.isInteger(b.n)) return { status: 'error', code: 'bad_request' };
        return steps.stepDone(slug, {
          n: b.n, note: typeof b.note === 'string' ? b.note : undefined, skip: b.skip === true,
        }, { waitMs: STEP_DONE_WAIT_MS }); // longer than this and the host drops the request; the mod asks again on "running"
      },
      send_message: async (slug, body) => requests.send(slug, body),
      report_blocked: async (slug, body) => {
        const reason = (body as { reason?: unknown } | null)?.reason;
        if (typeof reason !== 'string' || reason.trim() === '') return { status: 'error', code: 'bad_request' };
        steps.reportBlocked(slug, reason.trim().slice(0, 500));
        return { status: 'ok' };
      },
      ticket_report: async (_slug, body) => {
        const name = (body as { name?: unknown } | null)?.name;
        if (typeof name !== 'string' || name === '') return { status: 'error', code: 'bad_request' };
        const r = await review.ticketReport(name, { rerun: (body as { rerun?: unknown }).rerun === true });
        return r.ok ? { status: 'ok', facts: r.facts, report: r.report, reportFile: r.reportFile } : { status: 'refused', code: r.code, ...(r.detail ? { detail: r.detail } : {}) };
      },
      request_review: async (_slug, body) => {
        const b = (typeof body === 'object' && body !== null ? body : {}) as { name?: unknown; model?: unknown };
        if (typeof b.name !== 'string' || b.name === '') return { status: 'error', code: 'bad_request' };
        const r = await review.requestReview(b.name, { model: typeof b.model === 'string' && b.model !== '' ? b.model : undefined });
        if (!r.ok) return { status: 'refused', code: r.code, ...(r.detail ? { detail: r.detail } : {}) };
        const { ok: _ok, status: result, ...rest } = r;
        return { status: 'ok', result, ...rest };
      },
      send_back_ticket: async (_slug, body) => {
        const b = (typeof body === 'object' && body !== null ? body : {}) as { name?: unknown; note?: unknown };
        if (typeof b.name !== 'string' || b.name === '' || typeof b.note !== 'string') return { status: 'error', code: 'bad_request' };
        const r = await review.sendBack(b.name, b.note);
        if (!r.ok) return { status: 'refused', code: r.code };
        const { ok: _ok, status: result, ...rest } = r;
        return { status: 'ok', result, ...rest };
      },
      review_verdict: async (slug, body) => {
        const r = await review.reviewVerdict(slug, body);
        if (!r.ok) return r.code === 'bad_request' ? { status: 'error', code: 'bad_request' } : { status: 'refused', code: r.code };
        const { ok: _ok, ...rest } = r;
        return { status: 'ok', ...rest };
      },
      propose_release: async () => release.proposeRelease(),
      start_recovery: async (_slug, body) => {
        const name = (body as { name?: unknown } | null)?.name;
        if (typeof name !== 'string' || name === '') return { status: 'error', code: 'bad_request' };
        const r = await recovery.start(name);
        if (!r.ok) return { status: 'refused', code: r.code, ...(r.detail ? { detail: r.detail } : {}) };
        const { ok: _ok, ...rest } = r;
        return { status: 'ok', ...rest };
      },
      recovery_report: async (slug, body) => {
        const r = await recovery.report(slug, body);
        if (!r.ok) return r.code === 'bad_request' ? { status: 'error', code: 'bad_request' } : { status: 'refused', code: r.code };
        const { ok: _ok, ...rest } = r;
        return { status: 'ok', ...rest };
      },
      merge_ticket: async (_slug, body) => {
        const name = (body as { name?: unknown } | null)?.name;
        if (typeof name !== 'string' || name === '') return { status: 'error', code: 'bad_request' };
        return merge.mergeTicket(name);
      },
      spawn_agent: async (_slug, body) => {
        const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
        if (typeof b.name !== 'string' || typeof b.profile !== 'string' || typeof b.goal !== 'string' || b.goal.trim() === '') {
          return { status: 'error', code: 'bad_request' };
        }
        // An optional token budget for this ticket: an integer between 1000 and 100 000 000, anything else is refused.
        if (b.budget !== undefined && !(typeof b.budget === 'number' && Number.isInteger(b.budget) && b.budget >= 1000 && b.budget <= 100_000_000)) {
          return { status: 'error', code: 'bad_request' };
        }
        const out = await spawnAgent(ctx, { slug: b.name, profile: b.profile, goal: b.goal, model: typeof b.model === 'string' ? b.model : undefined, source: 'main', ...(b.budget !== undefined ? { budget: b.budget as number } : {}), ...(typeof b.repo === 'string' ? { repo: b.repo } : {}) });
        if (!out.ok) return { status: 'error', code: out.code, ...(out.params ? { params: out.params } : {}) };
        return out.status === 'started' ? { status: 'started', name: out.slug } : { status: 'queued', name: out.slug, position: out.position };
      },
    },
    projectName,
    projectRoot: o.projectRoot,
    claudeCommand: o.claudeCommand ?? config.claude.command,
    ...(o.prereqRunner ? { commandRunner: o.prereqRunner } : {}),
    get bypass() { return runtime.bypass; },
    get language() { return shared.language(); },
    bundles,
    testMode: process.env.CONSOLE_TEST === '1',
    configPath,
    repos, forgetRepos, prepareRepo,
    getPrereq: () => shared.getPrereq(),
    getHelperUse: () => shared.helperUsage.state(),
    ensurePrereq: () => shared.ensurePrereq(),
    refreshPrereq: () => shared.refreshPrereq(),
    setLanguage: (l) => { shared.setLanguage(l); },
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
    projects: shared.projectsApi,
    models: new ModelCatalog({ configDir: o.configDir, config: () => config.models }),
    plugins: new PluginCatalog({ configDir: o.configDir, config: () => config.plugins }),
    applyConfig: (next, applied) => {
      // In place, per sub-object: closures that read `config.budget` / `runtime.git` keep seeing the live object.
      if (isPlain(applied.agents)) {
        // The request settings are read on every use (RequestService deps), so copying them is enough.
        for (const key of ['maxActiveGlobal', 'maxActivePerProject', 'requestTimeoutMinutes', 'requestMaxHops'] as const) {
          if (key in applied.agents) config.agents[key] = next.agents[key];
        }
        limits.global = config.agents.maxActiveGlobal;
        limits.perProject = config.agents.maxActivePerProject;
        for (const r of shared.runtimes) r.parts.scheduler.release();
      }
      if (isPlain(applied.budget)) {
        const { loop, quota, ...flat } = next.budget;
        Object.assign(config.budget, flat);
        Object.assign(config.budget.loop, loop);
        Object.assign(config.budget.quota, quota);
      }
      if (isPlain(applied.git)) {
        for (const key of Object.keys(applied.git) as (keyof Config['git'])[]) Object.assign(runtime.git, { [key]: next.git[key] });
      }
      if (isPlain(applied.models)) Object.assign(config.models, next.models);
      if (isPlain(applied.plugins)) Object.assign(config.plugins, next.plugins);
    },
  };
  c.provide('ctx', () => ctx);

  // The HTTP and WebSocket servers are console-wide (see `startServer`); a reading entry goes to the sockets of this project only.
  reading.on((slug, entry) => shared.pushToProject(projectName, { type: 'reading', slug, entry }));

  registry.on(() => broadcast());
  // A slot freed in this project may start another project's queue (the global limit); the projects are released in the order they were opened.
  registry.on(() => { for (const r of shared.runtimes) if (r.ctx !== ctx) r.parts.scheduler.release(); });
  registry.on((slug) => notify.onRegistryChange(registry.get(slug)));
  questions.onAdd((q) => notify.onItem(q));
  void notify.checkAvailability();
  registry.on((slug) => persister.onChange(slug));
  // A session waits for the user exactly while it has an open question.
  questions.onChange(() => {
    for (const a of registry.list()) {
      // The wait is over: the minutes spent waiting for the user are not a silence.
      if (a.role !== 'main' && a.state === 'waiting_user' && !questions.hasPending(a.slug)) loop.detector.onModEvent(a.slug);
      registry.setWaitingUser(a.slug, questions.hasPending(a.slug));
    }
    broadcast();
  });
  ptys.onExit((id) => {
    // A reviewer that ends without a verdict (it crashed, or was closed) must not leave its ticket in review for ever.
    if (registry.get(id)?.role === 'reviewer' && !registry.get(id)?.finishing && review.abandonReview(id)) broadcast();
    // Nor a recovery that ends without its report, also one the console ended: the ticket waits again in the status it was stopped
    // in (after an accepted report this is a no-op: the report already forgot the session).
    if (registry.get(id)?.role === 'recovery' && recovery.abandon(id)) broadcast();
    // A resumed agent whose process ended before its session reported in never ran: its ticket waits again, and the main is told.
    if (resumedAwaitingStart.delete(id) && registry.get(id)?.role === 'agent' && ticketStatusOf(id) === 'in_progress') {
      try { tickets.move(id, 'suspended_limit'); } catch { /* told below anyway */ }
      inbox.push(projectName, `The resumed agent "${id}" ended before its session started; its ticket is suspended for the limit again. Try resume_agent once more, or tell the user.`);
    }
    questions.dropFrom(id);
    registry.onProcessExit(id);
    tokens.revoke(id);
    inbox.clear(id);
    restrictions.clear(id);
    loop.forget(id);
    permissions.forget(id);
    broadcast();
  });
  // The silence chip changes with the clock, not with an event: the state is pushed when what it would show has changed.
  let silenceShown = '';
  const refreshSilence = (): void => {
    const now = registry.list().filter((a) => a.role !== 'main').map((a) => `${a.slug}:${loop.silentFor(a.slug) ?? ''}`).join('|');
    if (now === silenceShown) return;
    silenceShown = now;
    broadcast();
  };
  // Only the grace period can move a budget step without a turn: checked on a timer that never keeps the process alive.
  const budgetTick = setInterval(() => {
    void budget.tick().catch((err) => budget.reportFailure('all agents', err));
    try { requests.tick(); } catch { /* a failed tick is tried again at the next one */ } // a question nobody answered in time goes to the main
    loop.tick(); // never throws: the time signals only warn the main
    try { refreshSilence(); } catch { /* the chip is only a hint */ }
  }, o.tickMs ?? 30_000);
  budgetTick.unref?.();
  /** One quota reading: a wake-up probe waiting for it judges it once the steps have been applied. */
  const onQuotaReading = c.get('onQuotaReading');
  // Phase 6A: runs when the project starts, not when its runtime is created (the sleep saved by an earlier run is restored by the host).
  let staleTimer: ReturnType<typeof setInterval> | undefined;
  const startProject = (): void => {
    // Phase 6A, SPEC 19: the agents of the earlier run come back dormant (no process, no quota spent), or interrupted when their turn
    // was lost; the main resumes its own session at once and is told which is which.
    const restored = restoreAgents({
      records: store.listAgents(), registry, tickets, worktrees: runtime.git.worktrees, cleanStop: previousRunWasClean,
      worktreeExists: (path) => existsSync(path), abandonReview: (reviewer) => review.abandonReview(reviewer),
    });
    // The time the console was off does not count against the requests' timeout.
    requests.restartClocks();
    // What an earlier run never delivered stays only for agents that can still read it.
    for (const slug of inbox.slugs()) {
      const state = registry.get(slug)?.state;
      if (slug !== projectName && state !== 'dormant' && state !== 'interrupted') inbox.clear(slug);
    }
    launchMain(mainResumeId);
    try {
      const notice = renderRestartNotice(restored);
      if (notice) inbox.push(projectName, notice);
    } catch { /* the notice is a courtesy: list_agents tells the same */ }
    staleTimer = setInterval(() => { void staleChecker.check(); }, 24 * 60 * 60_000);
    staleTimer.unref?.();
    void staleChecker.check();
    central.start(); // merges no full run has covered yet (done before this start) get one
  };

  return {
    ctx, name: projectName, root: o.projectRoot,
    // The prerequisite checks start with the console (background; unknown is null in the state and agent creation waits for it).
    start: () => { startProject(); },
    summary: () => ({ name: projectName, root: o.projectRoot, waiting: questions.pending().length, mainStatus: ptys.status(projectName) === 'running' ? 'running' : ptys.status(projectName) === 'exited' ? 'exited' : 'pending' }),
    onQuota: onQuotaReading,
    wakeMain,
    weeklyNotice,
    parts: { budget, scheduler },
    close: async () => {
      clearInterval(budgetTick);
      notify.close(); // before killing: the exits below must not announce "interrupted"
      if (staleTimer) clearInterval(staleTimer);
      // What a restart needs is on disk as it is now: the processes dying below must not rewrite it (their exits would empty the inbox
      // and mark every agent interrupted).
      persister.close();
      inbox.freeze();
      resumer.close();
      for (const h of wakeTimers) sleepClock.clearTimeout(h);
      wakeTimers.clear();
      quotaWaiters.clear();
      launchWatch.close();
      central.cancel();
      for (const timer of endTimers) clearTimeout(timer);
      endTimers.clear();
      scheduler.close(); // before killing: exiting processes would otherwise free slots and start queued agents
      await ptys.killAll();
      store.writeCleanStop(true); // the very end of this project: a crash before this line leaves `false`
    },
  };
}

/** Where the open projects are remembered between runs. */
const projectsFile = (configDir: string): string => join(configDir, 'projects.json');

/** The remembered projects; a damaged or missing file is no projects. */
function readProjectsFile(configDir: string): { root: string; name: string }[] {
  const parsed = readJsonFile(projectsFile(configDir));
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((p): p is { root: string; name: string } => typeof p?.root === 'string' && typeof p?.name === 'string');
}

/** The same folder, as the projects compare it: resolved, and case-insensitive on Windows. */
const sameFolder = (a: string, b: string): boolean => (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/**
 * Starts the console: one HTTP+WebSocket server on 127.0.0.1 hosting the projects (Phase 6C). The project of `o.projectRoot` is opened
 * first, then the projects remembered in `<configDir>/projects.json` whose folder still exists; each has its own runtime and main session.
 */
export async function startServer(o: StartOptions): Promise<RunningServer> {
  hardenExecutableSearch(); // before the first git or claude is started
  installProcessGuards(join(o.configDir, 'errors.log')); // an unhandled rejection is logged there and does not stop the console
  const configPath = join(o.configDir, 'config.json');
  const { config } = loadConfig(configPath);
  const token = createToken();
  const loginCodes = new LoginCodes();
  const sleepFile = join(o.configDir, 'state', 'sleep.json');
  const sleepClock: SleepClock = o.sleepClock ?? {
    now: () => Date.now(),
    setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; },
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  let port = 0;
  let language: string = config.language;
  let prereq: PrereqResult[] | null = null;
  let startupChecks: Promise<PrereqResult[]> | undefined;
  const runtimes: ProjectRuntime[] = [];
  // Opening or closing a project is one at a time: two requests for the same folder must not both pass the duplicate check.
  let projectChain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = projectChain.then(fn);
    projectChain = run.catch(() => undefined);
    return run;
  };
  let closing = false;

  // What the request handler needs from the console itself: it answers even when no project is open.
  const host: HostContext = {
    getPort: () => port, token, loginCodes, assets: new UiAssets(resourcePath('dist', 'ui'), process.env.CONSOLE_APP_ROOT === undefined), configDir: o.configDir,
    version: o.version ?? resolveVersion(appRoot()),
    get bundles() { return shared.bundles; },
    get projects() { return shared.projectsApi; },
    ensurePrereq: () => shared.ensurePrereq(),
    // The window's title follows the interface language ("auto" is resolved by the browser, so the server uses English for it).
    ...(o.updates ? { updates: o.updates } : {}),
    ...(o.groqFetch ? { groqFetch: o.groqFetch } : {}),
    pickFolder: o.pickFolder ?? createFolderPicker({
      title: () => {
        const lang = shared.language() !== 'auto' && shared.bundles.has(shared.language()) ? shared.language() : 'en';
        const t = createTranslator({ lang, messages: shared.bundles.get(lang) ?? {}, fallback: shared.bundles.get('en') });
        return t('folder.pick.title');
      },
    }),
    info: () => ({ projects: runtimes.map((r) => r.summary()), language: shared.language(), languages: [...shared.bundles.keys()].sort(), needsSetup: !existsSync(configPath) }),
  };
  const server = http.createServer((req, res) => {
    void createRequestHandler(projectCtx, host)(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'internal' }));
    });
  });
  /** `?project=<name>`: the project with that name; no name is the first project. */
  function projectCtx(name?: string): Context | undefined {
    return name === undefined || name === '' ? runtimes[0]?.ctx : runtimes.find((r) => r.name === name)?.ctx;
  }
  const ws = attachWebSockets(server, projectCtx);
  o.updates?.onChange(() => ws.broadcastState()); // a found, downloading or downloaded version reaches the page at once

  const persistProjects = (): void => {
    writeJsonAtomic(projectsFile(o.configDir), runtimes.map((r) => ({ root: r.root, name: r.name })));
  };

  // The install runs from the console's own folder and records in the config dir; one at a time for the whole console.
  const utilityPtys = new PtyManager();
  const installer = new InstallService({
    ...(o.installTable ? { table: o.installTable } : {}),
    ptys: utilityPtys, cwd: appRoot(), logPath: join(o.configDir, 'install.log'),
    prereq: () => shared.ensurePrereq(), refresh: () => shared.refreshPrereq(), changed: () => ws.broadcastState(),
    ...(o.installRunner ?? o.prereqRunner ? { run: (o.installRunner ?? o.prereqRunner)! } : {}),
  });

  const shared: Shared = {
    utilityPtys, installer,
    o, configPath, config, token, loginCode: () => loginCodes.issue(), bundles: loadBundles(o.i18nDir),
    ledger: new Ledger(join(o.configDir, 'ledger')),
    quotaState: new QuotaState(),
    // Heavy runs go one at a time; `ANDROMEDACONSOLE_TEST_CONCURRENCY` raises the limit on a machine with cores to spare.
    testQueue: new TestQueue({ limit: () => Number(process.env.ANDROMEDACONSOLE_TEST_CONCURRENCY) || 1, changed: () => ws.broadcastState() }),
    // The sleep timer and the account's limits are one per console; at a reset every project's main wakes.
    sleep: new SleepTimer({
      clock: sleepClock,
      // Not async on purpose: every project sets its wait timer synchronously, inside the sleep timer's own call.
      wakeMain: () => Promise.all(runtimes.map((r) => r.wakeMain())).then((all) => (all.length === 0 || all.includes('running') ? 'running' : 'limited')),
      persist: (s) => writeJsonAtomic(sleepFile, s),
      changed: () => ws.broadcastState(),
      weeklyNotice: (resetsAt) => { for (const r of runtimes) r.weeklyNotice(resetsAt); },
    }),
    sleepClock,
    // Settings read when a session is launched: a change applies to the sessions started afterwards, never to running ones.
    runtime: { bypass: config.agents.bypassPermissions, guardMode: config.guard.mode, git: { ...config.git, ...(o.worktrees !== undefined ? { worktrees: o.worktrees } : {}) } },
    limits: { global: config.agents.maxActiveGlobal, perProject: config.agents.maxActivePerProject },
    runtimes,
    projectsApi: undefined as unknown as ProjectsApi, // set just below
    getPort: () => port,
    broadcastAll: () => ws.broadcastState(),
    pushToProject: (project, payload) => ws.broadcastJson(payload, project),
    language: () => language,
    setLanguage: (l) => { language = l; },
    getPrereq: () => prereq,
    helperUsage: new HelperUsage(join(o.configDir, 'state', 'helper-usage.json')),
    ensurePrereq: () => prereq ? Promise.resolve(prereq) : (startupChecks ??= shared.refreshPrereq()),
    refreshPrereq: async () => {
      // The Claude check runs the configured command (not the test override), so a custom install is judged fairly.
      prereq = await runChecks(o.prereqRunner, { claudeCommand: config.claude.command });
      ws.broadcastState();
      return prereq;
    },
  };
  // A sleep saved by an earlier run is re-armed once the projects run again (Phase 6A): a time still ahead gets its timer, a time that
  // has passed gets one probe at once. The timer is console-wide, so the host restores it, not a project.
  let savedSleep: SleepState | undefined;
  const saved = readJsonFile(sleepFile) as Partial<SleepState> | undefined; // no saved state, or unreadable: nothing to restore
  if (saved && (saved.phase === 'sleeping' || saved.phase === 'probing') && typeof saved.attempt === 'number') {
    savedSleep = { until: typeof saved.until === 'string' ? saved.until : undefined, ...(saved.kind ? { kind: saved.kind } : {}), attempt: saved.attempt, phase: saved.phase };
  }

  /** Checks a folder and a name, opens the project (runtime, main session) and remembers it. */
  const addProject = (a: AddProjectOptions): Promise<{ name: string }> => exclusive(async () => {
    if (closing) throw new ProjectError('project.badRoot', 409);
    const root = resolve(a.root);
    if (runtimes.some((r) => sameFolder(r.root, root))) throw new ProjectError('project.duplicate', 409);
    const wanted = a.name ?? projectNameFromDir(root);
    if (!PROJECT_NAME_RE.test(wanted)) throw new ProjectError('project.badName', 422);
    if (runtimes.some((r) => r.name === wanted)) throw new ProjectError('project.duplicate', 409);
    if (a.create) mkdirSync(root, { recursive: true });
    else if (!(existsSync(root) && statSync(root).isDirectory())) throw new ProjectError('project.badRoot', 422);
    const source = a.copyFrom ? runtimes.find((r) => r.name === a.copyFrom) : undefined;
    if (a.copyFrom && !source) throw new ProjectError('project.notFound', 404);
    if (a.auto && !a.templateId && !source) {
      // The dialog only asked for the folder: what it holds says the template and the commands (the user changes them in Options).
      const found = detectProject(root);
      a = { ...a, templateId: found.source === 'package.json' ? 'frontend-web' : found.source ? 'backend-java' : 'generic',
        build: a.build ?? found.build, test: a.test ?? found.test, lint: a.lint ?? found.lint };
    }
    if (a.templateId) {
      // The template (Phase 6D) prepares the folder: git init, profiles, rules, commands.
      const { applyTemplate } = await import('./templates/apply');
      const done = await applyTemplate({ templateId: a.templateId, root, name: wanted, create: a.create === true, build: a.build, test: a.test, lint: a.lint, configDir: o.configDir });
      if (!done.ok) throw new ProjectError(done.code, 422);
    }
    const store = new ProjectStore(root);
    store.init(wanted);
    if (source) {
      // Another project's settings instead of a template: its profiles, rules and project.json fields.
      const { copyProjectSettings } = await import('./templates/copy');
      const copied = copyProjectSettings(source.root, root, wanted);
      if (!copied.ok) throw new ProjectError(copied.code, 422);
    } else if (!a.templateId) {
      if (a.test !== undefined) store.setTestCommand(a.test);
      store.setCommands({ build: a.build, lint: a.lint });
    }
    // An existing project.json keeps the name it was created with: it is the one that must be free.
    const name = store.project.name;
    if (runtimes.some((r) => r.name === name)) throw new ProjectError('project.duplicate', 409);
    const rt = await createProjectRuntime(shared, { projectRoot: root, projectName: name });
    runtimes.push(rt);
    rt.start();
    persistProjects();
    ws.broadcastState();
    return { name };
  });

  const closeProject = (name: string, purge = false): Promise<void> => exclusive(async () => {
    const rt = runtimes.find((r) => r.name === name);
    if (!rt) throw new ProjectError('project.notFound', 404);
    // What the purge needs is read before the project closes: the records say where every agent's worktree was.
    const records = purge ? rt.ctx.store.listAgents() : [];
    runtimes.splice(runtimes.indexOf(rt), 1);
    persistProjects();
    try { await rt.close(); } catch { /* the sessions were killed as far as they could be */ }
    if (purge) {
      const { purgeProject } = await import('./git/purge');
      try {
        await purgeProject({ projectRoot: rt.root, project: rt.name, slugs: records.map((a) => a.slug), worktrees: records.flatMap((a) => (a.worktree ? [a.worktree] : [])) });
      } catch (e) {
        console.warn(`console: the data of the project "${name}" could not be removed completely: ${errorMessage(e)}`);
      }
    }
    ws.closeProject(name);
    // Its slots are free: the projects still open may start their queues.
    for (const r of runtimes) r.parts.scheduler.release();
    ws.broadcastState();
  });

  /**
   * One project at a time: the agents that have a process are noted, the project closes (the sessions end, the next start finds them
   * dormant), opens again (its main resumes its session) and the noted agents are woken, so everything runs with the settings of now. The
   * console, its port and its token stay, and so does the PATH it was started with: it is never read again from the system.
   */
  const restartSessions = (): Promise<void> => exclusive(async () => {
    if (closing) throw new ProjectError('project.badRoot', 409);
    for (const old of [...runtimes]) {
      const running = old.ctx.registry.list().filter((a) => a.role === 'agent' && old.ctx.ptys.status(a.slug) === 'running').map((a) => a.slug);
      try { await old.close(); } catch { /* the sessions were killed as far as they could be */ }
      let rt: ProjectRuntime;
      try {
        rt = await createProjectRuntime(shared, { projectRoot: old.root, projectName: old.name });
      } catch (e) {
        runtimes.splice(runtimes.indexOf(old), 1); // closed and not reopened: leaving it listed would answer requests with a dead runtime
        persistProjects();
        ws.broadcastState();
        throw e;
      }
      runtimes[runtimes.indexOf(old)] = rt;
      rt.start();
      for (const slug of running) await rt.ctx.wake.wake(slug, 'user'); // a refusal (no session yet, frozen quota) leaves it dormant
    }
    ws.broadcastState();
    void shared.refreshPrereq().catch(() => undefined); // a program installed meanwhile is "restart" until the new PATH is seen
  });

  shared.projectsApi = {
    list: () => runtimes.map((r) => r.summary()),
    contexts: () => runtimes.map((r) => r.ctx),
    add: addProject,
    close: closeProject,
    restart: restartSessions,
  };

  // The CLI's project first, then the remembered ones whose folder still exists (a missing one is skipped and reported once).
  if (o.projectRoot !== undefined) runtimes.push(await createProjectRuntime(shared, { projectRoot: o.projectRoot, projectName: o.projectName ?? projectNameFromDir(o.projectRoot) }));
  const given = o.projectRoot;
  const remembered = readProjectsFile(o.configDir).filter((p) => given === undefined || !sameFolder(p.root, given));
  const toOpen: { root: string; name: string }[] = [];
  for (const p of remembered) {
    if (existsSync(p.root) && statSync(p.root).isDirectory()) toOpen.push(p);
    else console.warn(`console: the project "${p.name}" was skipped: its folder ${p.root} does not exist any more`);
  }
  for (const p of toOpen) {
    try {
      if (runtimes.some((r) => r.name === p.name || sameFolder(r.root, p.root))) continue;
      const rt = await createProjectRuntime(shared, { projectRoot: resolve(p.root), projectName: p.name });
      if (runtimes.some((r) => r.name === rt.name)) { await rt.close(); continue; }
      runtimes.push(rt);
    } catch (e) {
      console.warn(`console: the project "${p.name}" could not be opened: ${errorMessage(e)}`);
    }
  }
  persistProjects();

  await new Promise<void>((ok, err) => {
    server.once('error', err);
    server.listen(o.port, '127.0.0.1', () => ok()); // never another interface (SPEC 4.5)
  });
  const addr = server.address() as AddressInfo;
  port = addr.port;
  const url = `http://127.0.0.1:${port}`;

  startupChecks = shared.refreshPrereq(); // background; unknown is null in the state and agent creation waits for it
  for (const r of runtimes) r.start();
  if (savedSleep) shared.sleep.restore(savedSleep);

  return {
    port, address: addr.address, token, url, loginUrl: () => `${url}/?code=${loginCodes.issue()}`,
    // The members below are bound to the first project (the one a request with no `?project=` gets).
    sessionTokenFor: (slug) => runtimes[0]?.ctx.tokens.tokenFor(slug),
    sendMessage: (slug, text) => runtimes[0]!.ctx.inbox.push(slug, text),
    writeToSession: (slug, data) => runtimes[0]!.ctx.ptys.write(slug, data),
    setLimits: (l) => { shared.limits.global = l.global; shared.limits.perProject = l.perProject; for (const r of runtimes) r.parts.scheduler.release(); },
    setBudgetLimit: (slug, limit) => runtimes[0]!.parts.budget.setLimit(slug, limit),
    lastLaunchArgs: (slug) => runtimes[0]?.ctx.launchLog.get(slug),
    addProject: (root, name) => addProject({ root, ...(name !== undefined ? { name } : {}) }),
    closeProject,
    projects: () => runtimes.map((r) => r.summary()),
    runningAgentCount: () => runtimes.reduce((n, r) => n + r.ctx.registry.list().filter((a) => a.role !== 'main' && r.ctx.ptys.status(a.slug) === 'running').length, 0),
    close: async () => {
      closing = true;
      shared.sleep.close();
      shared.helperUsage.flush();
      await projectChain; // an opening or closing in progress ends first
      for (const r of [...runtimes]) await r.close();
      await utilityPtys.killAll();
      ws.closeAll();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
