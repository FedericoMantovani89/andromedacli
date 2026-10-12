import type { Inbox } from '../agents/inbox';
import type { ProjectStore } from '../project-store';
import type { PermissionMemory } from '../questions/permission-memory';
import type { QuestionQueue } from '../questions/queue';
import type { ReadingStore } from '../reading/store';
import type { RequestStore } from '../requests/store';
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
}
export type ProjectContainer = Container<Services>;
