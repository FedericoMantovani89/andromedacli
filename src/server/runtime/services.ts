import type { createTranslator } from '../../shared/i18n';
import type { Inbox } from '../agents/inbox';
import type { AgentRegistry } from '../agents/registry';
import type { ProjectStore, TestMoment } from '../project-store';
import type { PtyManager } from '../pty/pty-manager';
import type { TestRunner } from '../tickets/test-queue';
import type { PermissionMemory } from '../questions/permission-memory';
import type { QuestionQueue } from '../questions/queue';
import type { ReadingStore } from '../reading/store';
import type { RequestStore } from '../requests/store';
import type { SessionTokens } from '../security';
import type { StateProblems } from '../state-problems';
import type { TicketStore } from '../tickets/store';
import type { Container } from './container';
import type { Env } from './env';

/** Every service of a project, by name. Each area adds its own (see the register of the area). */
export interface Services {
  env: Env;
  // state (runtime/state.ts)
  stateProblems: StateProblems;
  store: ProjectStore;
  previousRunWasClean: boolean;
  projectName: string;
  inbox: Inbox;
  questions: QuestionQueue;
  permissions: PermissionMemory;
  reading: ReadingStore;
  tickets: TicketStore;
  requestStore: RequestStore;
  secretPatterns: () => string[];
  // tests (runtime/tests.ts)
  detectedTestCommand: () => string | undefined;
  testsDisabled: () => boolean;
  testCommandAt: (moment: TestMoment) => () => string | undefined;
  testRunnerAt: (moment: TestMoment) => TestRunner;
  reportLanguage: () => { lang: string; t: ReturnType<typeof createTranslator> };
  // agents (runtime/agents.ts)
  ptys: PtyManager;
  tokens: SessionTokens;
  mainResumeId: () => string | undefined;
  registry: AgentRegistry;
  sessionGuardMode: Map<string, 'enforce' | 'shadow'>;
  launchLog: Map<string, string[]>;
  repos: () => string[];
  forgetRepos: () => void;
  prepareRepo: (path: string) => Promise<void>;
}
export type ProjectContainer = Container<Services>;
