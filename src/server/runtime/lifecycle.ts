import { existsSync } from 'node:fs';
import { renderRestartNotice, restoreAgents } from '../agents/restore';
import type { ProjectContainer } from './services';

/** Start, close and the timers of a project: what runs on the clock and what ends the project. */
export function registerLifecycle(c: ProjectContainer): void {
  // The silence chip changes with the clock, not with an event: the state is pushed when what it would show has changed.
  c.provide('refreshSilence', (k) => {
    const registry = k.get('registry');
    const loop = k.get('loop');
    const broadcast = k.get('broadcast');
    let silenceShown = '';
    return (): void => {
      const now = registry.list().filter((a) => a.role !== 'main').map((a) => `${a.slug}:${loop.silentFor(a.slug) ?? ''}`).join('|');
      if (now === silenceShown) return;
      silenceShown = now;
      broadcast();
    };
  });
  // Only the grace period can move a budget step without a turn: checked on a timer that never keeps the process alive.
  c.provide('budgetTick', (k) => {
    const { o } = k.get('env');
    const budget = k.get('budget');
    const requests = k.get('requests');
    const loop = k.get('loop');
    const refreshSilence = k.get('refreshSilence');
    const timer = setInterval(() => {
      void budget.tick().catch((err) => budget.reportFailure('all agents', err));
      try { requests.tick(); } catch { /* a failed tick is tried again at the next one */ } // a question nobody answered in time goes to the main
      loop.tick(); // never throws: the time signals only warn the main
      try { refreshSilence(); } catch { /* the chip is only a hint */ }
    }, o.tickMs ?? 30_000);
    timer.unref?.();
    return timer;
  });
  c.provide('staleTimerRef', () => ({ value: undefined }));
  // Phase 6A: runs when the project starts, not when its runtime is created (the sleep saved by an earlier run is restored by the host).
  c.provide('startProject', (k) => {
    const { runtime } = k.get('env');
    const store = k.get('store');
    const registry = k.get('registry');
    const tickets = k.get('tickets');
    const previousRunWasClean = k.get('previousRunWasClean');
    const review = k.get('review');
    const requests = k.get('requests');
    const inbox = k.get('inbox');
    const projectName = k.get('projectName');
    const mainResumeId = k.get('mainResumeId')();
    const staleChecker = k.get('staleChecker');
    const central = k.get('central');
    const staleTimerRef = k.get('staleTimerRef');
    return (): void => {
      const launchMain = k.get('launchMain');
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
      staleTimerRef.value = setInterval(() => { void staleChecker.check(); }, 24 * 60 * 60_000);
      staleTimerRef.value.unref?.();
      void staleChecker.check();
      central.start(); // merges no full run has covered yet (done before this start) get one
    };
  });
  c.provide('summary', (k) => {
    const { o } = k.get('env');
    const projectName = k.get('projectName');
    const questions = k.get('questions');
    const ptys = k.get('ptys');
    return () => ({ name: projectName, root: o.projectRoot, waiting: questions.pending().length, mainStatus: ptys.status(projectName) === 'running' ? 'running' : ptys.status(projectName) === 'exited' ? 'exited' : 'pending' });
  });
  c.provide('close', (k) => {
    const { sleepClock } = k.get('env');
    const budgetTick = k.get('budgetTick');
    const staleTimerRef = k.get('staleTimerRef');
    const notify = k.get('notify');
    const persister = k.get('persister');
    const inbox = k.get('inbox');
    const resumer = k.get('resumer');
    const wakeTimers = k.get('wakeTimers');
    const quotaWaiters = k.get('quotaWaiters');
    const launchWatch = k.get('launchWatch');
    const central = k.get('central');
    const endTimers = k.get('endTimers');
    const scheduler = k.get('scheduler');
    const ptys = k.get('ptys');
    const store = k.get('store');
    return async (): Promise<void> => {
      clearInterval(budgetTick);
      notify.close(); // before killing: the exits below must not announce "interrupted"
      if (staleTimerRef.value) clearInterval(staleTimerRef.value);
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
    };
  });
}
