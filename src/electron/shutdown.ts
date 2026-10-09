export interface ShutdownGate {
  /** True until the stop has finished: a close or a quit must be held back meanwhile (a second click must not end the app mid-stop). */
  blocks(): boolean;
  /** A stop is running or done. */
  stopping(): boolean;
  /** Stops once (concurrent callers share it), then exits. The exit happens even if the stop fails. */
  stopAndExit(): Promise<void>;
  /** Stops once without exiting: the update restart stops first, then lets the app quit by itself. */
  stop(): Promise<void>;
}

/**
 * The one place that decides when the desktop app may end. The server's stop writes the clean-stop flag of every project (SPEC 19) and
 * can take a while with agents running, so nothing may end the process before it is over.
 */
export function createShutdownGate(o: { stop(): Promise<void>; exit(): void }): ShutdownGate {
  let running: Promise<void> | undefined;
  let stopped = false;
  let exited = false;
  const stop = (): Promise<void> => {
    running ??= o.stop().catch(() => undefined).finally(() => { stopped = true; });
    return running;
  };
  return {
    blocks: () => !stopped,
    stopping: () => running !== undefined,
    stop,
    stopAndExit: async () => {
      await stop();
      if (exited) return; // two requests meant one exit
      exited = true;
      o.exit();
    },
  };
}
