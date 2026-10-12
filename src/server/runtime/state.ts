import { join } from 'node:path';
import { Inbox } from '../agents/inbox';
import { ProjectStore } from '../project-store';
import { PermissionMemory } from '../questions/permission-memory';
import { QuestionQueue } from '../questions/queue';
import { ReadingStore } from '../reading/store';
import { RequestStore } from '../requests/store';
import { StateProblems } from '../state-problems';
import { TicketStore } from '../tickets/store';
import type { ProjectContainer } from './services';

/** The services that keep the project's state on disk (and the queues that live beside it). */
export function registerState(c: ProjectContainer): void {
  // State files the console could not read are set aside and listed here; the page shows them until the user dismisses them.
  c.provide('stateProblems', (k) => { const { o, shared } = k.get('env'); return new StateProblems(o.projectRoot, () => shared.broadcastAll()); });
  c.provide('store', (k) => {
    const { o } = k.get('env');
    const store = new ProjectStore(o.projectRoot, k.get('stateProblems').add);
    store.init(o.projectName);
    return store;
  });
  // Phase 6A: did the last run end through close()? A crash leaves `false`. This run is "not clean" until its own close() says so.
  c.provide('previousRunWasClean', (k) => { const store = k.get('store'); const clean = store.readCleanStop(); store.writeCleanStop(false); return clean; });
  // The project keeps the name it was created with, even if its folder is renamed later (it is also the main session id).
  c.provide('projectName', (k) => k.get('store').project.name);
  // What was not delivered before a stop is delivered after the restart (messages for dormant agents wait for their wake-up).
  c.provide('inbox', (k) => {
    const { o } = k.get('env');
    const inbox = new Inbox(join(o.projectRoot, '.andromedaconsole', 'state', 'inbox.json'), k.get('stateProblems').add);
    inbox.load();
    return inbox;
  });
  c.provide('questions', () => new QuestionQueue());
  c.provide('permissions', () => new PermissionMemory());
  c.provide('reading', (k) => { const { o } = k.get('env'); return new ReadingStore(join(o.projectRoot, '.andromedaconsole', 'state', 'reading')); });
  /** The global secret patterns plus the project's own (Phase 6D). */
  c.provide('secretPatterns', (k) => { const { runtime } = k.get('env'); const store = k.get('store'); return (): string[] => [...runtime.git.secretPatterns, ...(store.fields().secretPatterns ?? [])]; });
  c.provide('tickets', (k) => { const { o } = k.get('env'); return new TicketStore(o.projectRoot, k.get('stateProblems').add); });
  // Requests between agents (SPEC 10). Persisted per project: a restart keeps ids, deadlines and the waiting steps.
  c.provide('requestStore', (k) => {
    const { o } = k.get('env');
    const requestStore = new RequestStore(join(o.projectRoot, '.andromedaconsole', 'state', 'requests.json'), k.get('stateProblems').add);
    requestStore.load();
    return requestStore;
  });
}
