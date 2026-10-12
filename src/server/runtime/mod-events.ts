import type { Context } from '../http';
import type { ProjectContainer } from './services';

/** Everything that reacts to an event of the console mod (registry, reading store, loop detector, budget). */
export function handleModEvent(k: ProjectContainer): Context['handleModEvent'] {
  const { shared } = k.get('env');
  const registry = k.get('registry');
  const questions = k.get('questions');
  const permissions = k.get('permissions');
  const reading = k.get('reading');
  const resumedAwaitingStart = k.get('resumedAwaitingStart');
  const loop = k.get('loop');
  const turns = k.get('turns');
  const budget = k.get('budget');
  const broadcast = k.get('broadcast');
  return (slug, e) => {
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
  };
}
