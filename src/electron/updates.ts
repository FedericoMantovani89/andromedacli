// New versions of the desktop app (SPEC 33.4): the app looks on GitHub for a newer release, the page shows it, and the user decides.
// Nothing is downloaded or installed on its own; a check that fails (offline, a private repository, no release) is silent.
import { autoUpdater } from 'electron-updater';
import type { UpdateControl, UpdateState } from '../shared/update';

const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 4 * 60 * 60_000;

export interface UpdatesOptions {
  /** Asked before the restart when agents are still running: false means the user changed their mind. */
  confirmStop(): Promise<boolean>;
}

export function createUpdates(o: UpdatesOptions): UpdateControl {
  let state: UpdateState | undefined;
  const listeners: (() => void)[] = [];
  const set = (next: UpdateState | undefined): void => {
    state = next;
    for (const cb of listeners) cb();
  };

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;
  autoUpdater.on('update-available', (info) => { if (state?.phase !== 'downloading' && state?.phase !== 'ready') set({ phase: 'available', version: info.version }); });
  autoUpdater.on('download-progress', (p) => { if (state) set({ phase: 'downloading', version: state.version, percent: Math.round(p.percent) }); });
  autoUpdater.on('update-downloaded', (info) => { set({ phase: 'ready', version: info.version }); });
  // A download that broke can be started again; a failed check changes nothing.
  autoUpdater.on('error', () => { if (state?.phase === 'downloading') set({ phase: 'available', version: state.version }); });

  const check = (): void => { void autoUpdater.checkForUpdates().catch(() => undefined); };
  setTimeout(check, FIRST_CHECK_MS).unref();
  setInterval(check, CHECK_EVERY_MS).unref();

  return {
    state: () => state,
    download: () => {
      if (state?.phase !== 'available') return;
      set({ phase: 'downloading', version: state.version, percent: 0 });
      void autoUpdater.downloadUpdate().catch(() => { if (state?.phase === 'downloading') set({ phase: 'available', version: state.version }); });
    },
    install: async () => {
      if (state?.phase !== 'ready') return;
      if (!(await o.confirmStop())) return;
      // The installer starts and waits for this app to end; the app's own quit handler then stops the server cleanly (SPEC 19).
      autoUpdater.quitAndInstall(false, true);
    },
    onChange: (cb) => { listeners.push(cb); },
  };
}
