/** Time source of the sleep timer: injected so tests never wait (the class itself owns no real timers). */
export interface SleepClock { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void }

export interface SleepState {
  /** When the next probe is due (ISO). Absent while awake. */
  until: string | undefined;
  kind?: 'five_hour' | 'seven_day' | 'spend_limit';
  /** Failed probes so far. */
  attempt: number;
  phase: 'sleeping' | 'probing' | 'awake';
}

export interface SleepDeps {
  clock: SleepClock;
  /** One check that the main runs again. Never called twice at once. A rejection counts as 'limited'. */
  wakeMain(): Promise<'running' | 'limited'>;
  /** Every state change, so a later phase can resume it. */
  persist(s: SleepState): void;
  changed(): void;
  /** A weekly limit never restarts by itself (SPEC 18.5): the user is told and chooses. Called once per weekly sleep. */
  weeklyNotice(resetsAt: string | undefined): void;
}

/** Minutes between probes after a failed one; the last step repeats. */
export const BACKOFF_MINUTES = [5, 10, 20] as const;
/** Margin after the reset time, so the probe does not land just before the limit is lifted. */
const MARGIN_MS = 5000;
/**
 * A reset further away than this is not a five-hour window: it is treated as a wrong time (the backoff applies). It also keeps the
 * delay far below the 2^31-1 ms a timer can hold (a larger one fires after 1 ms).
 */
const MAX_DELAY_MS = 7 * 24 * 60 * 60_000;

/**
 * Code, not a model (SPEC 18.4): when a usage limit is reached the console sleeps until `resetsAt` with no attempt in the
 * meantime, then wakes only the main with one probe. A probe that finds the limit still on backs off 5, 10, 20, 20... minutes.
 * A weekly limit wins over a five-hour one: it sets no timer and nothing restarts by itself.
 */
export class SleepTimer {
  private current: SleepState = { until: undefined, attempt: 0, phase: 'awake' };
  private handle: unknown;
  private pending = false;
  private probing = false;
  private closed = false;
  /** A weekly limit that arrived while a probe was running: applied when the probe ends limited. */
  private weeklyAfterProbe: { resetsAt: string | undefined } | undefined;

  constructor(private readonly d: SleepDeps) {}

  state(): SleepState { return { ...this.current }; }

  /** Shows a state saved by an earlier run. It never resumes anything (a declared limit: Phase 6) and sets no timer. */
  load(saved: SleepState): void {
    if (this.pending || this.probing) return;
    this.current = { ...saved, phase: saved.phase === 'awake' ? 'awake' : 'sleeping' };
  }

  /**
   * Re-arms a sleep saved by an earlier run (Phase 6A). A five-hour sleep whose time is still ahead waits for that time with the saved
   * attempt; one whose time has passed (or is unknown) probes at once. A weekly sleep sets no timer: it is only shown, as before.
   * Call it after the main was started: the probe wakes the main.
   */
  restore(saved: SleepState): void {
    if (this.closed || this.pending || this.probing) return;
    if (saved.phase === 'awake') return;
    if (saved.kind === 'seven_day') { this.load(saved); return; }
    const until = saved.until === undefined ? Number.NaN : Date.parse(saved.until);
    const now = this.d.clock.now();
    const attempt = Number.isFinite(saved.attempt) && saved.attempt > 0 ? Math.floor(saved.attempt) : 0;
    this.current = { until: saved.until, ...(saved.kind ? { kind: saved.kind } : {}), attempt, phase: 'sleeping' };
    if (Number.isFinite(until) && until > now && until - now <= MAX_DELAY_MS) {
      this.arm(until - now);
      this.set({ ...this.current });
    } else {
      this.fire();
    }
  }

  private isWeekly(): boolean { return this.current.phase !== 'awake' && this.current.kind === 'seven_day'; }

  sleepUntil(resetsAt: string | undefined, kind: SleepState['kind']): void {
    if (this.closed) return;
    if (kind === 'seven_day') {
      // No timer: the reset can be days away. The notice once per weekly sleep, and the state so the UI can say it.
      if (!this.isWeekly() && this.weeklyAfterProbe === undefined) this.d.weeklyNotice(resetsAt);
      if (this.probing) {
        this.weeklyAfterProbe = { resetsAt };
        return;
      }
      this.disarm(); // a pending five-hour wake-up must not wake the main while the week is used up
      this.setWeekly(resetsAt, this.isWeekly() ? this.current.attempt : 0);
      return;
    }
    if (this.isWeekly()) return; // the weekly limit decides: a five-hour reset does not wake anything
    if (this.pending || this.probing) return; // the earlier timer stays
    const now = this.d.clock.now();
    const at = resetsAt === undefined ? Number.NaN : Date.parse(resetsAt);
    const delay = Number.isFinite(at) && at > now && at - now <= MAX_DELAY_MS ? at - now + MARGIN_MS : BACKOFF_MINUTES[0] * 60_000;
    this.set({ until: new Date(now + delay).toISOString(), kind, attempt: 0, phase: 'sleeping' });
    this.arm(delay);
  }

  /**
   * A valid reading below the freeze threshold: the limit is lifted, so the sleep ends (a pending timer and a weekly state too).
   * Nothing happens while a probe runs (its own reading decides) or while awake.
   */
  lifted(): void {
    if (this.closed || this.probing || this.current.phase === 'awake') return;
    this.disarm();
    this.weeklyAfterProbe = undefined;
    this.set({ until: undefined, attempt: 0, phase: 'awake' });
  }

  /** The "resume now" button: one probe at once. Nothing happens while a probe is already running or when nothing sleeps. */
  resumeNow(): void {
    if (this.closed || this.probing || this.current.phase !== 'sleeping') return;
    this.disarm();
    this.fire();
  }

  /** Shutdown: no timer outlives the console, and a probe that settles afterwards schedules nothing. */
  close(): void {
    this.closed = true;
    this.disarm();
  }

  private setWeekly(resetsAt: string | undefined, attempt: number): void {
    const valid = resetsAt !== undefined && Number.isFinite(Date.parse(resetsAt));
    this.set({ until: valid ? resetsAt : undefined, kind: 'seven_day', attempt, phase: 'sleeping' });
  }

  private arm(ms: number): void {
    if (this.closed) return;
    this.pending = true;
    this.handle = this.d.clock.setTimeout(() => { this.pending = false; this.handle = undefined; this.fire(); }, ms);
  }

  private disarm(): void {
    if (!this.pending) return;
    this.d.clock.clearTimeout(this.handle);
    this.pending = false;
    this.handle = undefined;
  }

  private set(s: SleepState): void {
    this.current = s;
    try { this.d.persist({ ...s }); } catch { /* a state that cannot be saved is still shown */ }
    try { this.d.changed(); } catch { /* the UI push must not break the timer */ }
  }

  private fire(): void {
    if (this.probing || this.closed) return;
    this.probing = true;
    this.set({ ...this.current, phase: 'probing' });
    let run: Promise<'running' | 'limited'>;
    try { run = this.d.wakeMain(); } catch (err) { run = Promise.reject(err); }
    void run.catch((): 'limited' => 'limited').then((result) => {
      this.probing = false;
      if (this.closed) return;
      const weekly = this.weeklyAfterProbe;
      this.weeklyAfterProbe = undefined;
      if (result === 'running') {
        this.set({ until: undefined, attempt: 0, phase: 'awake' });
        return;
      }
      const attempt = this.current.attempt + 1;
      if (weekly) {
        this.setWeekly(weekly.resetsAt, attempt);
        return;
      }
      if (this.current.kind === 'seven_day') {
        // A weekly limit never schedules a wake-up; the user can try again with the button.
        this.set({ ...this.current, attempt, phase: 'sleeping' });
        return;
      }
      const delay = BACKOFF_MINUTES[Math.min(attempt, BACKOFF_MINUTES.length - 1)]! * 60_000;
      this.set({ ...this.current, until: new Date(this.d.clock.now() + delay).toISOString(), attempt, phase: 'sleeping' });
      this.arm(delay);
    });
  }
}
