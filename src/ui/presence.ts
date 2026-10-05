import type { PresenceReport } from '../shared/notify';
import type { StateMessage } from '../shared/protocol';
import { api } from './api';

/** How often a report is sent while the page is visible; the server counts a report older than 40 s as "no console in front". */
const HEARTBEAT_MS = 15_000;
/** How often the page looks for a change (the active panel, the drawer) to report at once. */
const WATCH_MS = 2_000;

/**
 * Tells the server what the user is looking at, so a toast is not raised for what is already in front of them (SPEC 20.3).
 * Reports on load, on visibility and window focus changes, when the drawer or the active panel changes, and as a heartbeat.
 * Never touches the keyboard focus (it only reads it).
 */
export function startPresence(getState: () => StateMessage | undefined, getActive: () => string, isDrawerOpen: () => boolean): { stop(): void } {
  let lastSent = '';
  let lastAt = 0;
  const current = (): PresenceReport => ({
    focused: document.hasFocus(), visible: document.visibilityState === 'visible', drawerOpen: isDrawerOpen(), active: getActive(),
  });
  const report = (force: boolean): void => {
    if (!getState()) return;
    const r = current();
    const text = JSON.stringify(r);
    const now = Date.now();
    if (!force && text === lastSent && now - lastAt < HEARTBEAT_MS) return;
    lastSent = text;
    lastAt = now;
    void api('/api/presence', { method: 'POST', body: r }).catch(() => { /* the server is gone: the next report tries again */ });
  };
  const onChange = (): void => report(true);
  document.addEventListener('visibilitychange', onChange);
  window.addEventListener('focus', onChange);
  window.addEventListener('blur', onChange);
  const timer = setInterval(() => { if (document.visibilityState === 'visible') report(false); }, WATCH_MS);
  report(true);
  return {
    stop(): void {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onChange);
      window.removeEventListener('focus', onChange);
      window.removeEventListener('blur', onChange);
    },
  };
}
