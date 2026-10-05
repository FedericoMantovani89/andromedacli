import http from 'node:http';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRequestHandler, type Context } from './http';
import { attachWebSockets } from './ws';
import { loadBundles } from './i18n-bundles';
import { loadConfig } from './config';
import { PlanStore } from './plan-store';
import { PtyManager } from './pty/pty-manager';
import { buildClaudeLaunch, SESSION_ID_RE } from './pty/claude-launch';
import { createToken, SessionTokens } from './security';
import { AgentRegistry } from './agents/registry';
import { Inbox } from './agents/inbox';
import { Scheduler } from './agents/scheduler';
import { CONSOLE_FROM, QuestionQueue } from './questions/queue';
import { ReadingStore } from './reading/store';
import { failQueuedStart, launchAgent, launchResume, spawnAgent } from './agents/spawn';
import { ResumeService, type WakeResult } from './agents/resume';
import { TicketStore } from './tickets/store';
import { StepService } from './tickets/steps';
import { ReviewService } from './tickets/review';
import { RecoveryService, replacementCheckout } from './tickets/recovery';
import { MergeService } from './tickets/merge';
import { ReleaseService } from './tickets/release';
import { installReleaseHook } from './git/release-hook';
import { commonDir, removeWorktree } from './git/worktree';
import { createTranslator } from '../shared/i18n';
import { LaunchWatch } from './agents/launch-watch';
import { resolveVersion } from './version';
import { evaluate } from './guard/rules';
import { excludeConsoleFolder } from './git/worktree';
import { GuardLog } from './guard/log';
import { languageName, renderMainPrompt } from './profiles';
import { runChecks, type Runner } from './prereq/checks';
import type { PrereqResult } from '../shared/protocol';
import { Ledger } from './budget/ledger';
import { defaultProjectsDir, pickTranscript, TranscriptReader } from './budget/transcript';
import { BudgetService } from './budget/service';
import { readHandoverNote } from './tickets/handover';
import { Restrictions } from './budget/restrictions';
import { budgetAnswerHandler } from './budget/answers';
import { commitWip } from './git/commit';
import { LoopDetector } from './budget/loop-detector';
import { LoopService } from './budget/loop-service';
import { QuotaService, QuotaState, type QuotaStep } from './budget/quota';
import { SleepTimer, type SleepClock, type SleepState } from './budget/sleep';
import { writeJsonAtomic } from './fs-atomic';
import { AgentPersister } from './agents/persist';
import { renderRestartNotice, restoreAgents } from './agents/restore';
import { WakeService } from './agents/wake';
import { StaleChecker, latestCommitMs } from './git/stale';
import { cleanupWorktree } from './git/cleanup';

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
  /** Build version override (tests); default: the latest tag on main of the console's own repository. */
  version?: string;
  /** How long after a launch the console checks that the agent started and took its goal (default 90 s; tests use less). */
  launchCheckMs?: number;
  /** Overrides `git.worktrees` from the configuration (embedding and tests: agents share the plan folder when false). */
  worktrees?: boolean;
  /** A test seam: runs once an agent's worktree exists, before its process starts; a throw simulates a failed start. */
  afterWorktreeCreated?: (slug: string) => void | Promise<void>;
  /** Where Claude Code keeps its transcripts (default `~/.claude/projects`, or `$CLAUDE_CONFIG_DIR/projects`); tests use a temp folder. */
  projectsDir?: string;
  /** How often the budget grace period is checked without a turn (default 30 s; tests use less). */
  tickMs?: number;
  /** A test seam: the clock of the sleep timer (the real one is used by default). */
  sleepClock?: SleepClock;
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
  /** Changes the token budget of an agent's ticket (a test seam, like `setLimits`); the step is recomputed from the usage. */
  setBudgetLimit(slug: string, limit: number): void;
  /** Arguments the session was launched with (a test seam). */
  lastLaunchArgs(slug: string): string[] | undefined;
  close(): Promise<void>;
}

/** The one message the main gets when a usage limit resets (SPEC 18.4). */
export const WAKE_MESSAGE = 'The subscription limit was reset. Check the suspended tickets with list_agents and resume them with mcp__console-mod__resume_agent.';
/** How long a wake-up probe waits for the next quota reading before it counts as still limited. */
const WAKE_WAIT_MS = 60_000;

/** Starts the console: one HTTP+WebSocket server on 127.0.0.1, the plan store and the main session. */
export async function startServer(o: StartOptions): Promise<RunningServer> {
  const configPath = join(o.configDir, 'config.json');
  const { config } = loadConfig(configPath);
  const store = new PlanStore(o.planRoot);
  store.init(o.planName);
  // Phase 6A: did the last run end through close()? A crash leaves `false`. This run is "not clean" until its own close() says so.
  const previousRunWasClean = store.readCleanStop();
  store.writeCleanStop(false);
  // The plan keeps the name it was created with, even if its folder is renamed later (it is also the main session id).
  const planName = store.plan.name;
  const ptys = new PtyManager();
  const token = createToken();
  const tokens = new SessionTokens();
  // What was not delivered before a stop is delivered after the restart (messages for dormant agents wait for their wake-up).
  const inbox = new Inbox(join(o.planRoot, '.console', 'state', 'inbox.json'));
  inbox.load();
  const registry = new AgentRegistry();
  // The main's last session (state/main.json): the first launch resumes it, so the main keeps its context across a restart.
  const savedMainSession = store.readMainSession();
  const mainResumeId = savedMainSession !== undefined && SESSION_ID_RE.test(savedMainSession) ? savedMainSession : undefined;
  registry.register({ slug: planName, role: 'main', profile: 'main', ...(mainResumeId !== undefined ? { sessionId: mainResumeId } : {}) });
  const questions = new QuestionQueue();
  const reading = new ReadingStore(join(o.planRoot, '.console', 'state', 'reading'));
  const limits = { global: config.agents.maxActiveGlobal, perPlan: config.agents.maxActivePerPlan };
  // Settings read when a session is launched: a change applies to the sessions started afterwards, never to running ones.
  const runtime = { bypass: config.agents.bypassPermissions, guardMode: config.guard.mode, git: { ...config.git, ...(o.worktrees !== undefined ? { worktrees: o.worktrees } : {}) } };
  // The guard mode a session was launched under: a later change in Settings does not reach sessions already running.
  const sessionGuardMode = new Map<string, 'enforce' | 'shadow'>([[planName, config.guard.mode]]);
  const tickets = new TicketStore(o.planRoot);
  const bundles = loadBundles(o.i18nDir);
  const launchWatch = new LaunchWatch({ registry, delayMs: () => o.launchCheckMs ?? 90_000, notifyMain: (text) => { inbox.push(planName, text); broadcast(); } });
  const endTimers = new Set<ReturnType<typeof setTimeout>>(); // reviewers about to be ended; cancelled at shutdown
  /**
   * A reviewer's or a recovery's work is done once it has spoken: end it a moment later (its tool answer still has to reach it) and
   * remove its checkout and its hook folder.
   */
  const endReadOnlySession = (slug: string): void => {
    const git = registry.get(slug)?.git;
    const timer = setTimeout(() => {
      endTimers.delete(timer);
      void finishAgent(slug).then(() => (git ? removeWorktree(o.planRoot, git.worktree) : undefined)).then(async () => { rmSync(join(await commonDir(o.planRoot), 'console-hooks', slug), { recursive: true, force: true }); }).catch(() => undefined);
    }, 3000);
    timer.unref?.();
    endTimers.add(timer);
  };
  const reportLanguage = () => {
    const lang = language !== 'auto' && bundles.has(language) ? language : 'en';
    return { lang, t: createTranslator({ lang, messages: bundles.get(lang) ?? {}, fallback: bundles.get('en') }) };
  };
  const review = new ReviewService({
    tickets, root: o.planRoot, plan: planName,
    worktreeOf: (slug) => registry.get(slug)?.git,
    testCommand: () => store.plan.testCommand,
    testTimeoutMs: () => runtime.git.testTimeoutMinutes * 60_000,
    // Report headings follow the interface language; "auto" is resolved by the browser, so the server uses English for it.
    language: reportLanguage,
    spawnReviewer: async (r) => {
      const out = await spawnAgent(ctx, { slug: r.slug, profile: 'reviewer', goal: r.goal, model: r.model, source: 'main', review: { ticket: r.ticket, sha: r.sha } });
      return out.ok ? { ok: true } : { ok: false, code: out.code, detail: out.params?.reason !== undefined ? String(out.params.reason) : out.code };
    },
    existingSlugs: () => [planName, ...store.listAgents().map((a) => a.slug)],
    authorAlive: (slug) => registry.get(slug)?.state !== 'interrupted' && ptys.status(slug) === 'running',
    notifyMain: (text) => { inbox.push(planName, text); },
    notifyAuthor: (slug, text) => { inbox.push(slug, text); },
    askUser: (q, onAnswer) => { questions.ask({ from: CONSOLE_FROM, text: q.text, kind: 'decision', options: q.options, payload: q.payload }, onAnswer); },
    endReviewer: (slug) => endReadOnlySession(slug),
  });
  const merge = new MergeService({
    tickets, root: o.planRoot, plan: planName,
    worktreeOf: (slug) => registry.get(slug)?.git,
    testCommand: () => store.plan.testCommand,
    testTimeoutMs: () => runtime.git.testTimeoutMinutes * 60_000,
    squash: () => store.plan.squash !== false,
    language: reportLanguage,
    authorAlive: (slug) => registry.get(slug)?.state !== 'interrupted' && registry.get(slug)?.state !== 'finished' && ptys.status(slug) === 'running',
    notifyMain: (text) => { inbox.push(planName, text); },
    notifyAuthor: (slug, text) => { inbox.push(slug, text); },
    needsUser: (slug, reason) => { review.askUserAboutTicket(slug, reason); },
    finishAgent: async (slug) => { await finishAgent(slug); registry.setGit(slug, undefined); },
  });
  const release = new ReleaseService({
    tickets, root: o.planRoot, plan: planName,
    testCommand: () => store.plan.testCommand,
    testTimeoutMs: () => runtime.git.testTimeoutMinutes * 60_000,
    language: reportLanguage,
    notifyMain: (text) => { inbox.push(planName, text); },
    askConfirm: (q, onAnswer) => questions.ask({ from: CONSOLE_FROM, text: q.text, kind: 'confirm', payload: q.payload }, onAnswer).id,
    changed: () => broadcast(),
  });
  /** Ends a session on purpose (a merged ticket, a finished review): its state becomes "finished", not "interrupted". */
  const finishAgent = async (slug: string): Promise<void> => {
    registry.markFinished(slug);
    await ptys.killTree(slug);
  };
  /** The handover note an agent wrote in its worktree (`.console/handover.md`), at most 4000 characters; undefined when none. */
  const readHandover = (slug: string): string | undefined => {
    const worktree = registry.get(slug)?.git?.worktree;
    if (!worktree) return undefined;
    return readHandoverNote(worktree);
  };
  /** At a stop the note goes into the ticket while the worktree is still there (a recovery reads it, a replacement gets it). */
  const keepHandover = (slug: string): void => {
    const text = readHandover(slug);
    if (!text) return;
    try { tickets.setHandover(slug, text); } catch { /* no ticket: nothing to keep it in */ }
  };
  // Token budgets (SPEC 16): usage from the Claude Code transcript, recorded in the monthly ledger, steps on the ticket.
  const projectsDir = o.projectsDir ?? defaultProjectsDir();
  const ledger = new Ledger(join(o.configDir, 'ledger'));
  const reader = new TranscriptReader();
  const restrictions = new Restrictions();
  const turns = new Map<string, number>(); // turns started per session: the ledger's `turn`
  const budget: BudgetService = new BudgetService({
    tickets, ledger, reader, plan: planName, root: resolve(o.planRoot),
    // The loaded object, read on every call. The file is read once at startup and the Settings dialog does not edit `budget`, so
    // today this never changes while the console runs: "applies to the sessions launched afterwards" holds trivially.
    config: () => config.budget,
    now: () => Date.now(),
    transcriptOf: (slug) => {
      const a = registry.get(slug);
      // Claude Code files the transcript under the session's folder: the worktree (where it was started), then the folder it reported.
      return a?.sessionId ? pickTranscript(projectsDir, [a.git?.worktree, a.cwd], a.sessionId) : undefined;
    },
    isLive: (slug) => registry.get(slug)?.role === 'agent',
    wipCommit: async (slug, reason) => {
      const worktree = registry.get(slug)?.git?.worktree;
      if (!worktree) return { ok: false, detail: 'no worktree' };
      const r = await commitWip({ worktree, slug, plan: planName, reason, secretPatterns: runtime.git.secretPatterns });
      return r.ok ? { ok: true, sha: r.sha } : { ok: false, detail: `${r.code}${r.files ? `: ${r.files.join(', ')}` : r.detail ? `: ${r.detail}` : ''}` };
    },
    tellAgent: (slug, text) => { inbox.push(slug, text); },
    tellMain: (text) => { inbox.push(planName, text); },
    restrict: (slug, why) => { restrictions.set(slug, { reason: why }); },
    stop: (slug) => { keepHandover(slug); return finishAgent(slug); },
    // The answer handler lives in budget/answers.ts; the service only asks.
    askUser: (q) => {
      questions.ask({ from: CONSOLE_FROM, text: q.text, kind: 'decision', options: q.options, payload: q.payload }, (answer) => { void onBudgetAnswer(answer, q.payload as { ticket: string }).catch((err) => budget.reportFailure('the budget answer', err)); });
    },
    changed: () => broadcast(),
  });
  // Recovery after a stop (SPEC 16.5): a read-only session diagnoses, then a NEW agent takes the ticket over on the same branch.
  const recovery: RecoveryService = new RecoveryService({
    tickets, ledger, root: resolve(o.planRoot), plan: planName,
    worktreeOf: (slug) => registry.get(slug)?.git,
    testCommand: () => store.plan.testCommand,
    testTimeoutMs: () => runtime.git.testTimeoutMinutes * 60_000,
    spawnRecovery: async (r) => {
      const out = await spawnAgent(ctx, { slug: r.slug, profile: 'recovery', goal: r.goal, model: r.model, source: 'main', recovery: { ticket: r.ticket, sha: r.sha } });
      return out.ok ? { ok: true } : { ok: false, code: out.code, detail: out.params?.reason !== undefined ? String(out.params.reason) : out.code };
    },
    spawnReplacement: async (r) => {
      // The stopped agent's restriction goes with its session; the new name never inherits one.
      restrictions.clear(r.from);
      if (ptys.status(r.from) === 'running') await finishAgent(r.from);
      const old = registry.get(r.from)?.git;
      // No fallback to a normal spawn: without the stopped agent's worktree the new one would start on a NEW branch.
      const checkout = replacementCheckout(runtime.git.worktrees, old);
      if (!checkout.ok) return { ok: false, code: checkout.code, detail: `the worktree of ${r.from} is not known` };
      if (old) {
        // Whatever is still uncommitted is kept on the branch before the folder goes (git refuses a branch checked out twice).
        const wip = await commitWip({ worktree: old.worktree, slug: r.from, plan: planName, reason: 'handover', secretPatterns: runtime.git.secretPatterns });
        if (!wip.ok) return { ok: false, code: 'wip_failed', detail: `${wip.code}${wip.files ? `: ${wip.files.join(', ')}` : wip.detail ? `: ${wip.detail}` : ''}` };
        await removeWorktree(o.planRoot, old.worktree);
        rmSync(join(await commonDir(o.planRoot), 'console-hooks', r.from), { recursive: true, force: true });
        registry.setGit(r.from, undefined);
      }
      const out = await spawnAgent(ctx, {
        slug: r.slug, profile: r.profile, goal: r.goal, model: r.model, source: 'main',
        ...(r.budget !== undefined ? { budget: r.budget } : {}), ...(old ? { resumeBranch: old.branch } : {}),
      });
      return out.ok ? { ok: true } : { ok: false, code: out.code, detail: out.params?.reason !== undefined ? String(out.params.reason) : out.code };
    },
    existingSlugs: () => [planName, ...store.listAgents().map((a) => a.slug)],
    notifyMain: (text) => { inbox.push(planName, text); },
    askUser: (q, onAnswer) => { questions.ask({ from: CONSOLE_FROM, text: q.text, kind: 'decision', options: q.options, payload: q.payload }, onAnswer); },
    endRecovery: (slug) => endReadOnlySession(slug),
    budget,
    profileOf: (ticket) => store.listAgents().find((a) => a.slug === ticket)?.profile ?? registry.get(ticket)?.profile ?? 'backend',
    readHandover,
    changed: () => broadcast(),
  });
  const onBudgetAnswer = budgetAnswerHandler({ budget, tickets, recovery, tellMain: (text) => { inbox.push(planName, text); }, changed: () => broadcast() });
  // Loops and blocks (SPEC 17): found in the transcript events, handled in three steps; time signals only warn the main.
  const loop = new LoopService({
    detector: new LoopDetector(() => config.budget.loop, () => Date.now()),
    tickets,
    tellAgent: (slug, text) => { inbox.push(slug, text); },
    tellMain: (text) => { inbox.push(planName, text); },
    restrict: (slug, r) => { restrictions.set(slug, r); },
    // Only a loop restriction goes when a step closes: one held for the budget or the usage limit stays.
    clearRestriction: (slug) => { if (restrictions.get(slug)?.reason === 'loop') restrictions.clear(slug); },
    wipCommit: async (slug, reason) => {
      const worktree = registry.get(slug)?.git?.worktree;
      if (!worktree) return { ok: false, detail: 'no worktree' };
      const r = await commitWip({ worktree, slug, plan: planName, reason, secretPatterns: runtime.git.secretPatterns });
      return r.ok ? { ok: true } : { ok: false, detail: `${r.code}${r.files ? `: ${r.files.join(', ')}` : r.detail ? `: ${r.detail}` : ''}` };
    },
    stop: (slug) => { keepHandover(slug); return finishAgent(slug); },
    workingSlugs: () => registry.list().filter((a) => a.role === 'agent' && a.state === 'working').map((a) => a.slug),
    processAlive: (slug) => ptys.status(slug) === 'running',
    changed: () => broadcast(),
  });
  // Usage limits of the subscription (SPEC 18): the mod reports them, the service decides the step.
  const quotaState = new QuotaState();
  let quotaStep: QuotaStep = 'none'; // read by the scheduler on every decision
  const sleepFile = join(o.planRoot, '.console', 'state', 'sleep.json');
  const sleepClock: SleepClock = o.sleepClock ?? {
    now: () => Date.now(),
    setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; },
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  // The probe of a wake-up waits for the next quota reading (the main's next turn reports it), at most WAKE_WAIT_MS.
  const quotaWaiters = new Set<() => void>();
  const wakeTimers = new Set<unknown>();
  /**
   * The one check at the reset (SPEC 18.4): only the main wakes, with one message, never one per agent. A main whose process is gone
   * is started again with `--resume` of its last session. The result is "running" only if the next quota reading, within a minute,
   * is below the freeze threshold (the one resume_agent uses); anything else (no reading, still high) is "limited" and the sleep
   * timer backs off.
   * Not async on purpose: the wait timer is set synchronously, inside the sleep timer's own call.
   */
  const wakeMain = (): Promise<WakeResult> => {
    let note = '';
    if (ptys.status(planName) !== 'running') {
      const sid = registry.get(planName)?.sessionId;
      const resumeId = sid !== undefined && SESSION_ID_RE.test(sid) ? sid : undefined;
      launchMain(resumeId);
      if (!resumeId) note = ' Your earlier session had ended and could not be resumed (its id was unknown), so this is a new session: look at the plan with list_agents before deciding anything.';
    }
    const result = new Promise<WakeResult>((done) => {
      let settled = false;
      let timer: unknown;
      const finish = (r: WakeResult): void => {
        if (settled) return;
        settled = true;
        quotaWaiters.delete(onQuota);
        sleepClock.clearTimeout(timer);
        wakeTimers.delete(timer);
        done(r);
      };
      const onQuota = (): void => {
        const worst = quotaState.worst();
        finish(worst !== undefined && worst.percent < config.budget.quota.freezePercent ? 'running' : 'limited');
      };
      quotaWaiters.add(onQuota);
      timer = sleepClock.setTimeout(() => finish('limited'), WAKE_WAIT_MS);
      wakeTimers.add(timer);
    });
    inbox.push(planName, `${WAKE_MESSAGE}${note}`);
    broadcast();
    return result;
  };
  const sleep = new SleepTimer({
    clock: sleepClock,
    wakeMain,
    persist: (s) => writeJsonAtomic(sleepFile, s),
    changed: () => broadcast(),
    weeklyNotice: (resetsAt) => {
      inbox.push(planName, `The weekly usage limit is almost used up or reached${resetsAt ? ` (it resets at ${resetsAt})` : ''}: the agents were paused and nothing restarts by itself. The user was asked in the queue; the choices are to wait until the reset, to go on with fewer agents or a cheaper model (set in the configuration), or to stop the plans.`);
      // SPEC 18.5: the USER gets the choice (the main may not be able to run at all): one item to acknowledge, its text lists the choices.
      questions.ask({ from: CONSOLE_FROM, text: 'The weekly usage limit is almost used up or reached: nothing restarts by itself.', kind: 'decision', options: ['ok'], payload: { kind: 'weekly_limit', ...(resetsAt ? { resetsAt } : {}) } });
    },
  });
  // A sleep saved by an earlier run is re-armed once the main is running again (Phase 6A, below): a time still ahead gets its timer,
  // a time that has passed gets one probe at once.
  let savedSleep: SleepState | undefined;
  try {
    const saved = JSON.parse(readFileSync(sleepFile, 'utf8')) as Partial<SleepState>;
    if (saved && (saved.phase === 'sleeping' || saved.phase === 'probing') && typeof saved.attempt === 'number') {
      savedSleep = { until: typeof saved.until === 'string' ? saved.until : undefined, ...(saved.kind ? { kind: saved.kind } : {}), attempt: saved.attempt, phase: saved.phase };
    }
  } catch { /* no saved state, or unreadable: nothing to restore */ }
  const ticketStatusOf = (slug: string) => { try { return tickets.get(slug)?.status; } catch { return undefined; } };
  const quota = new QuotaService({
    state: quotaState, config: () => config.budget.quota,
    tellMain: (text) => { inbox.push(planName, text); },
    tellAgent: (slug, text) => { inbox.push(slug, text); },
    // Priority = creation order of the registry (a Map keeps registration order): the oldest session has the highest number and is stopped last.
    agents: () => {
      const live = registry.list().filter((a) => a.state !== 'finished' && a.state !== 'interrupted' && a.state !== 'queued' && a.state !== 'dormant');
      return live.map((a, i) => ({ slug: a.slug, role: a.role, priority: live.length - i }));
    },
    wipCommit: async (slug, reason) => {
      // Only a ticket being written: a delivered or in-review author's branch must not move under its review.
      if (ticketStatusOf(slug) !== 'in_progress') return { ok: true };
      const worktree = registry.get(slug)?.git?.worktree;
      if (!worktree) return { ok: false, detail: 'no worktree' };
      const r = await commitWip({ worktree, slug, plan: planName, reason, secretPatterns: runtime.git.secretPatterns });
      return r.ok ? { ok: true } : { ok: false, detail: `${r.code}${r.files ? `: ${r.files.join(', ')}` : r.detail ? `: ${r.detail}` : ''}` };
    },
    restrict: (slug, r) => { restrictions.set(slug, r); },
    clearRestriction: (slug) => { if (restrictions.get(slug)?.reason === 'limit') restrictions.clear(slug); },
    suspendForLimit: async (slug) => {
      // Only a ticket being written is suspended. A reviewer or a recovery is ended and its ticket given back (delivered, or the
      // status it was stopped in): it is ended on purpose, so its exit alone would not give it back.
      const role = registry.get(slug)?.role;
      if (role === 'agent' && ticketStatusOf(slug) === 'in_progress') tickets.move(slug, 'suspended_limit');
      await finishAgent(slug);
      if (role === 'reviewer') review.abandonReview(slug);
      else if (role === 'recovery') recovery.abandon(slug);
    },
    // A step back to 'none' must start the queue by itself: the scheduler only looks again when told.
    applyLimits: (s) => { quotaStep = s; scheduler.release(); broadcast(); },
    onLimitReached: (resetsAt, kind) => sleep.sleepUntil(resetsAt, kind),
    changed: () => broadcast(),
  });
  // Resumed agents whose session has not reported in yet: one whose process ends first is suspended again (it never ran).
  const resumedAwaitingStart = new Set<string>();
  // Resuming suspended agents after a limit (SPEC 18.4): the main asks with resume_agent, the console staggers and checks the quota.
  const resumer = new ResumeService({
    tickets, registry,
    config: () => config.budget.quota,
    quotaWorst: () => quotaState.worst(),
    clock: sleepClock,
    launch: (slug, sessionId) => { resumedAwaitingStart.add(slug); return launchResume(ctx, slug, sessionId); },
    suspendedTickets: () => tickets.list().filter((t) => t.status === 'suspended_limit').map((t) => t.slug),
    // With worktrees off the agents share the plan folder: there is always somewhere to resume in.
    hasWorktree: (slug) => { if (!runtime.git.worktrees) return true; const w = registry.get(slug)?.git?.worktree; return w !== undefined && existsSync(w); },
    // Phase 6A: the main also wakes dormant and interrupted agents with resume_agent.
    wakeable: (slug) => { const s = registry.get(slug); return s?.role === 'agent' && (s.state === 'dormant' || s.state === 'interrupted'); },
    wake: async (slug, sessionId) => { const r = await launchResume(ctx, slug, sessionId, 'main'); return r; },
    tellMain: (text) => { inbox.push(planName, text); },
    changed: () => broadcast(),
  });
  // Waking a dormant agent (Phase 6A): the user opens it, work arrives for it, or the main asks (resume_agent, above).
  const waker = new WakeService({
    registry,
    launch: (slug, sessionId, reason) => launchResume(ctx, slug, sessionId, reason),
    hasWorktree: (slug) => { if (!runtime.git.worktrees) return true; const w = registry.get(slug)?.git?.worktree; return w !== undefined && existsSync(w); },
    quotaHigh: () => { const w = quotaState.worst(); return w !== undefined && w.percent >= config.budget.quota.freezePercent; },
    changed: () => broadcast(),
  });
  inbox.onPush((slug) => waker.onWork(slug));
  // Messages and state kept for the next start (Phase 6A).
  const persister = new AgentPersister({ registry, updateAgent: (slug, patch) => store.updateAgent(slug, patch), writeMainSession: (id) => store.writeMainSession(id), mainSlug: planName });
  const staleChecker = new StaleChecker({
    enabled: () => planIsRepo && runtime.git.worktrees && runtime.git.staleCheck,
    days: () => runtime.git.staleWorktreeDays,
    now: () => Date.now(),
    candidates: () => {
      const records = new Map(store.listAgents().map((a) => [a.slug, a]));
      return registry.list()
        .filter((a) => a.role === 'agent' && a.git !== undefined && ptys.status(a.slug) !== 'running' && a.state !== 'queued' && ticketStatusOf(a.slug) !== 'merged' && ticketStatusOf(a.slug) !== 'released')
        .map((a) => ({ slug: a.slug, worktree: a.git!.worktree, ...(records.get(a.slug)?.lastActiveAt ? { lastActiveAt: records.get(a.slug)!.lastActiveAt } : {}), ...(records.get(a.slug)?.stale ? { stale: true } : {}) }));
    },
    latestCommitMs,
    setStale: (slug, stale) => { store.updateAgent(slug, { stale: stale ? true : undefined }); },
    tellMain: (text) => { inbox.push(planName, text); },
    changed: () => broadcast(),
  });
  const guardLog = new GuardLog(join(o.planRoot, '.console', 'state', 'guard.jsonl'));
  const steps = new StepService({
    tickets, plan: planName,
    worktreeOf: (slug) => registry.get(slug)?.git,
    testCommand: () => store.plan.testCommand,
    testTimeoutMs: () => runtime.git.testTimeoutMinutes * 60_000,
    secretPatterns: () => runtime.git.secretPatterns,
    notifyMain: (_slug, text) => { inbox.push(planName, text); },
    changed: () => broadcast(),
    stepClosed: (slug, o) => loop.onStepDone(slug, o),
  });
  const launchLog = new Map<string, string[]>();
  // The scheduler's callbacks reach `ctx` (defined below) lazily, only once the server is running.
  const scheduler = new Scheduler({
    registry, limits: () => limits, multiplier: () => quotaStep,
    start: (r) => launchAgent(ctx, r),
    onStartError: (r) => failQueuedStart(ctx, r),
  });
  /**
   * Starts the main session: at startup, and again at a wake-up when its process had ended (`resumeId`: its last session, so it keeps
   * its context). A start after the first one is a new launch: it gets a new token and the settings of this moment.
   */
  function launchMain(resumeId: string | undefined): void {
    if (ptys.status(planName) !== 'unknown') {
      // Its last session id is kept: a relaunch that fails before reporting in is followed by a `--resume` on the next probe.
      const sessionId = registry.get(planName)?.sessionId;
      registry.register({ slug: planName, role: 'main', profile: 'main', ...(sessionId !== undefined ? { sessionId } : {}) });
      sessionGuardMode.set(planName, runtime.guardMode);
    }
    const launch = buildClaudeLaunch({
      command: ctx.claudeCommand, role: 'main', slug: planName, plan: planName,
      url: `http://127.0.0.1:${port}`, token: tokens.issue(planName), bypass: ctx.bypass, baseEnv: process.env,
      pluginDir: ctx.modDir,
      allowedTools: ctx.modDir ? ['mcp__console-mod__spawn_agent', 'mcp__console-mod__list_agents', 'mcp__console-mod__ask_user', 'mcp__console-mod__start_recovery', 'mcp__console-mod__resume_agent', 'mcp__console-mod__worktree_cleanup'] : undefined,
      appendPromptFile: renderMainPrompt({ plan: planName, workLanguage: languageName(config.language), outDir: ctx.promptsDir }),
      ...(resumeId !== undefined ? { resumeId } : {}),
    });
    ptys.spawn({ id: planName, ...launch, cwd: resolve(o.planRoot), cols: 120, rows: 30 });
    launchLog.set(planName, launch.args);
  }
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
  // Nobody pushes main from this checkout except the console, after the user approves a release (SPEC 9.1, 15.5).
  if (planIsRepo) await installReleaseHook(o.planRoot).catch(() => 'skipped_existing');

  const ctx: Context = {
    getPort: () => port,
    version: o.version ?? resolveVersion(resolve(import.meta.dirname, '..', '..')),
    token, ptys, store, tokens, inbox, registry, scheduler, launchLog, questions, reading, tickets, steps, launchWatch, review, recovery,
    budget, restrictions, loop, ledger, quotaState, sleep, wake: waker,
    afterWorktreeCreated: o.afterWorktreeCreated,
    get git() { return runtime.git; },
    get budgetConfig() { return config.budget; },
    get guardMode() { return runtime.guardMode; },
    modDir: o.modDir === null ? undefined : (o.modDir ?? (config.mod.enabled ? resolve(import.meta.dirname, '..', '..', 'mod') : undefined)),
    promptsDir: join(o.planRoot, '.console', 'state', 'prompts'),
    guard: (slug, tool, input) => {
      const rt = registry.get(slug);
      const role = rt?.role ?? 'agent';
      // The judge is the caller's own worktree and role, taken from its session: nothing in the request body can change them.
      const verdict = evaluate({ role: role === 'main' ? 'main' : 'agent', tool, input }, {
        readOnly: rt?.readOnly === true,
        worktree: role !== 'main' && rt?.git ? rt.git.worktree : o.planRoot, repo: o.planRoot,
        branch: rt?.git?.branch ?? '', planBranch: `plan/${planName}`, secretPatterns: runtime.git.secretPatterns,
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
    activity: (slug) => { if (registry.get(slug)?.role === 'agent') loop.detector.onModEvent(slug); },
    handleModEvent: (slug, e) => {
      // The account's limits are not agent activity: they never reach the registry nor reset the loop detector's silence. Never awaited.
      if (e.type === 'quota') {
        // A wake-up probe waiting for this reading judges it once the steps have been applied.
        void quota.onQuota(e.data?.rateLimits).then(() => {
          for (const w of [...quotaWaiters]) w();
          // A low reading ends a sleep even when no probe is waiting (a probe that timed out, a main that reported by itself).
          const worst = quotaState.worst();
          if (worst !== undefined && worst.percent < config.budget.quota.freezePercent) sleep.lifted();
        });
        return;
      }
      if (e.type === 'session.start') resumedAwaitingStart.delete(slug);
      // The turn ended: a question its tool call was waiting on (for example an aborted turn) has no asker any more.
      if (e.type === 'turn.complete') questions.dropFrom(slug);
      registry.onModEvent(slug, e);
      // The assistant's final text of a turn feeds the "read" panel (never read from the terminal).
      if (e.type === 'turn.complete' && typeof e.data?.answer === 'string') reading.add(slug, e.data.answer);
      if (e.type === 'turn.start') turns.set(slug, (turns.get(slug) ?? 0) + 1);
      const isAgent = registry.get(slug)?.role === 'agent';
      if (isAgent) loop.detector.onModEvent(slug);
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
      list_agents: async () => ({
        agents: registry.list().map((a) => ({
          slug: a.slug, profile: a.profile, role: a.role, state: a.state,
          ...(a.goal ? { goal: a.goal.length > 300 ? `${a.goal.slice(0, 300)}…` : a.goal } : {}),
          ...(a.state === 'queued' ? { queuedPosition: scheduler.position(a.slug) } : {}),
          // Where the ticket is when it is not simply being written (suspended, delivered...): the main decides what to resume from it.
          ...(() => { const t = a.role === 'agent' ? ticketStatusOf(a.slug) : undefined; return t && t !== 'in_progress' ? { ticket: t } : {}; })(),
        })),
      }),
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
          repo: resolve(o.planRoot), plan: planName, secretPatterns: runtime.git.secretPatterns,
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
        return questions.ask({
          from: slug, text: b.question, options: options && options.length > 0 ? options : undefined, multiSelect: b.multiSelect === true,
          kind: b.kind === 'permission' ? 'permission' : 'question',
          tool: typeof b.tool === 'string' ? b.tool : undefined, detail: typeof b.detail === 'string' ? b.detail : undefined,
        });
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
        });
      },
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
        const out = await spawnAgent(ctx, { slug: b.name, profile: b.profile, goal: b.goal, model: typeof b.model === 'string' ? b.model : undefined, source: 'main', ...(b.budget !== undefined ? { budget: b.budget as number } : {}) });
        if (!out.ok) return { status: 'error', code: out.code, ...(out.params ? { params: out.params } : {}) };
        return out.status === 'started' ? { status: 'started', name: out.slug } : { status: 'queued', name: out.slug, position: out.position };
      },
    },
    planName,
    planRoot: o.planRoot,
    claudeCommand: o.claudeCommand ?? config.claude.command,
    get bypass() { return runtime.bypass; },
    get language() { return language; },
    bundles,
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
  registry.on((slug) => persister.onChange(slug));
  // A session waits for the user exactly while it has an open question.
  questions.onChange(() => {
    for (const a of registry.list()) registry.setWaitingUser(a.slug, questions.hasPending(a.slug));
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
      inbox.push(planName, `The resumed agent "${id}" ended before its session started; its ticket is suspended for the limit again. Try resume_agent once more, or tell the user.`);
    }
    questions.dropFrom(id);
    registry.onProcessExit(id);
    tokens.revoke(id);
    inbox.clear(id);
    restrictions.clear(id);
    loop.forget(id);
    broadcast();
  });
  // Only the grace period can move a budget step without a turn: checked on a timer that never keeps the process alive.
  const budgetTick = setInterval(() => {
    void budget.tick().catch((err) => budget.reportFailure('all agents', err));
    loop.tick(); // never throws: the time signals only warn the main
  }, o.tickMs ?? 30_000);
  budgetTick.unref?.();
  startupChecks = refreshPrereq(); // background; unknown is null in the state and agent creation waits for it
  // Phase 6A, SPEC 19: the agents of the earlier run come back dormant (no process, no quota spent), or interrupted when their turn
  // was lost; the main resumes its own session at once and is told which is which.
  const restored = restoreAgents({
    records: store.listAgents(), registry, tickets, worktrees: runtime.git.worktrees, cleanStop: previousRunWasClean,
    worktreeExists: (path) => existsSync(path), abandonReview: (reviewer) => review.abandonReview(reviewer),
  });
  // What an earlier run never delivered stays only for agents that can still read it.
  for (const slug of inbox.slugs()) {
    const state = registry.get(slug)?.state;
    if (slug !== planName && state !== 'dormant' && state !== 'interrupted') inbox.clear(slug);
  }
  launchMain(mainResumeId);
  try {
    const notice = renderRestartNotice(restored);
    if (notice) inbox.push(planName, notice);
  } catch { /* the notice is a courtesy: list_agents tells the same */ }
  if (savedSleep) sleep.restore(savedSleep);
  const staleTimer = setInterval(() => { void staleChecker.check(); }, 24 * 60 * 60_000);
  staleTimer.unref?.();
  void staleChecker.check();

  return {
    port, address: addr.address, token, url,
    sessionTokenFor: (slug) => tokens.tokenFor(slug),
    sendMessage: (slug, text) => inbox.push(slug, text),
    writeToSession: (slug, data) => ptys.write(slug, data),
    setLimits: (l) => { limits.global = l.global; limits.perPlan = l.perPlan; scheduler.release(); },
    setBudgetLimit: (slug, limit) => budget.setLimit(slug, limit),
    lastLaunchArgs: (slug) => launchLog.get(slug),
    close: async () => {
      clearInterval(budgetTick);
      clearInterval(staleTimer);
      // What a restart needs is on disk as it is now: the processes dying below must not rewrite it (their exits would empty the inbox
      // and mark every agent interrupted).
      persister.close();
      inbox.freeze();
      sleep.close();
      resumer.close();
      for (const h of wakeTimers) sleepClock.clearTimeout(h);
      wakeTimers.clear();
      quotaWaiters.clear();
      launchWatch.close();
      for (const timer of endTimers) clearTimeout(timer);
      endTimers.clear();
      scheduler.close(); // before killing: exiting processes would otherwise free slots and start queued agents
      await ptys.killAll();
      ws.closeAll();
      await new Promise<void>((done) => server.close(() => done()));
      store.writeCleanStop(true); // the very end: a crash before this line leaves `false`
    },
  };
}
