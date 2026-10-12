import type { Services } from './services';

/**
 * The order in which a project's services are created. It is the textual order of the old `createProjectRuntime`, because some creations
 * have effects (`inbox.load()`, `store.writeCleanStop(false)`, a first write of a file) and those must happen in the same order. A service
 * that another one needs earlier is created earlier by the container; this list then finds it already made.
 */

/** Everything up to and including `broadcast`: the repositories are prepared right after (an `await`, so it cannot be a service). */
export const BOOT_BEFORE_PREPARE: readonly (keyof Services)[] = [
  'stateProblems', 'store', 'previousRunWasClean', 'projectName', 'ptys', 'tokens', 'inbox', 'registry', 'mainResumeId', 'questions',
  'permissions', 'reading', 'secretPatterns', 'detectedTestCommand', 'testsDisabled', 'testCommandAt', 'testRunnerAt', 'sessionGuardMode',
  'tickets', 'launchWatch', 'endTimers', 'endReadOnlySession', 'repoOfTicket', 'reportLanguage', 'ticketQueue', 'review', 'central', 'merge',
  'release', 'finishAgent', 'readHandover', 'keepHandover', 'restrictions', 'turns', 'budget', 'recovery', 'onBudgetAnswer', 'loop',
  'quotaWaiters', 'wakeTimers', 'wakeMain', 'weeklyNotice', 'ticketStatusOf', 'quota', 'resumedAwaitingStart', 'resumer', 'waker', 'persister',
  'repos', 'forgetRepos', 'prepareRepo', 'staleChecker', 'guardLog', 'steps', 'requestStore', 'requests', 'launchLog', 'scheduler',
  'launchMain', 'broadcast',
];

/** After the repositories are prepared: the notifications, the `ctx`, and what the clock and the start and close of the project need. */
export const BOOT_AFTER_PREPARE: readonly (keyof Services)[] = [
  'notifier', 'presence', 'notify', 'ctx',
  'refreshSilence', 'budgetTick', 'onQuotaReading', 'staleTimerRef', 'startProject', 'summary', 'close',
];

export const BOOT_ORDER: readonly (keyof Services)[] = [...BOOT_BEFORE_PREPARE, ...BOOT_AFTER_PREPARE];
