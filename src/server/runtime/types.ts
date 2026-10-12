import type { Context } from '../http';
import type { Bundles } from '../i18n-bundles';
import type { Config } from '../config';
import type { ProjectsApi } from '../projects-api';
import type { Ledger } from '../budget/ledger';
import type { TestQueue } from '../tickets/test-queue';
import type { QuotaState } from '../budget/quota';
import type { SleepClock, SleepTimer } from '../budget/sleep';
import type { HelperUsage } from '../helper-usage';
import type { PtyManager } from '../pty/pty-manager';
import type { InstallService } from '../prereq/install';
import type { BudgetService } from '../budget/service';
import type { Scheduler } from '../agents/scheduler';
import type { WakeResult } from '../agents/resume';
import type { ProjectTab, PrereqResult } from '../../shared/protocol';
import type { StartOptions } from '../index';

/** What is one per console, shared by reference by every project's runtime (Phase 6C). */
export interface Shared {
  /** The options the console was started with (the project-bound ones are overridden per project). */
  o: StartOptions;
  configPath: string;
  config: Config;
  token: string;
  /** A new single-use code for an address that opens the page (a notification click). */
  loginCode(): string;
  bundles: Bundles;
  ledger: Ledger;
  /** The account's limits: one reading for every project. */
  quotaState: QuotaState;
  /** The machine's one queue of long test runs: two full suites at once slow each other down and fail timing-sensitive tests. */
  testQueue: TestQueue;
  /** One sleep timer; at the reset it wakes the main of every project. */
  sleep: SleepTimer;
  sleepClock: SleepClock;
  /** The settings and limits read at each launch (Settings dialog), one set for the whole console. */
  runtime: { bypass: boolean; guardMode: 'enforce' | 'shadow'; git: Config['git'] };
  limits: { global: number; perProject: number };
  /** Every open project, in the order they were opened. */
  runtimes: ProjectRuntime[];
  projectsApi: ProjectsApi;
  getPort(): number;
  /** Any change in any project pushes the state to every UI socket (the tab dots need it). */
  broadcastAll(): void;
  /** Pushes a message about one project to that project's sockets only. */
  pushToProject(project: string, payload: unknown): void;
  language(): string;
  setLanguage(l: string): void;
  getPrereq(): PrereqResult[] | null;
  ensurePrereq(): Promise<PrereqResult[]>;
  refreshPrereq(): Promise<PrereqResult[]>;
  /** How often the shell commands of every session used each optional helper: one count for the whole console. */
  helperUsage: HelperUsage;
  /** Terminals that are not agent sessions (assisted installs): one set and one installer for the whole console. */
  utilityPtys: PtyManager;
  installer: InstallService;
}

/** One project: its own folder, sessions, agents, tickets and queue (a Context), started and closed on its own. */
export interface ProjectRuntime {
  ctx: Context;
  name: string;
  root: string;
  /** Starts the main session (the server is already listening). */
  start(): void;
  close(): Promise<void>;
  summary(): ProjectTab;
  /** A quota reading some project reported: this project's service applies its steps to its own agents. */
  onQuota(rateLimits: unknown): void;
  /** The one check at a reset: wakes this project's main only. */
  wakeMain(): Promise<WakeResult>;
  /** The weekly limit's notice for this project's main and queue. */
  weeklyNotice(resetsAt: string | undefined): void;
  /** A test seam of the host (`RunningServer.setBudgetLimit`) and the launch log. */
  parts: { budget: BudgetService; scheduler: Scheduler };
}
