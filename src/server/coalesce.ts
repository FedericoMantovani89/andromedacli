/**
 * Runs `fn` once for any number of `trigger()` calls made close together: the first starts a window of `ms`, the call happens at its
 * end. A trigger after (or during) the call opens the next window, so the last change always gets its call. The timer never keeps
 * the process alive.
 */
export function coalesce(fn: () => void, ms: number): { trigger(): void; cancel(): void } {
  let pending: ReturnType<typeof setTimeout> | undefined;
  return {
    trigger() {
      if (pending) return;
      pending = setTimeout(() => {
        pending = undefined; // before the call, so a trigger made by the call itself opens the next window
        fn();
      }, ms);
      pending.unref?.();
    },
    cancel() {
      if (pending) clearTimeout(pending);
      pending = undefined;
    },
  };
}
