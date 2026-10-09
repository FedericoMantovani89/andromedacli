// The desktop app (SPEC 33): the console's server runs inside this process and one window shows it.
import { app, BrowserWindow, dialog, shell } from 'electron';
import { join } from 'node:path';
import { configDir, loadConfig } from '../server/config';
import { loadBundles } from '../server/i18n-bundles';
import { startServer, type RunningServer } from '../server/index';
import type { PickFolderResult } from '../server/pick-folder';
import { createTranslator, type Translate } from '../shared/i18n';
import { isInternalUrl } from './window';

// The packaged app finds its shipped folders next to the program (SPEC 33.3); in development the repository root is used.
if (app.isPackaged) process.env.CONSOLE_APP_ROOT = join(process.resourcesPath, 'app-root');

// Chromium's own files (cache, local storage) must not share the console's config folder: Windows folder names ignore case.
app.setPath('userData', join(configDir(), 'electron'));
// The UI is text and terminals: no GPU process (SPEC 33.1).
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('in-process-gpu'); // and no separate GPU process either: one process less in memory

const PORT = Number(process.env.CONSOLE_PORT ?? 7391);

let server: RunningServer | undefined;
let win: BrowserWindow | undefined;
let quitting = false;

/** The interface language of the dialogs: the configured one, or the system's when it is "auto" and a bundle exists. */
function translator(): Translate {
  const bundles = loadBundles();
  const configured = loadConfig(join(configDir(), 'config.json')).config.language;
  const wanted = configured === 'auto' ? app.getLocale().slice(0, 2) : configured;
  const lang = bundles.has(wanted) ? wanted : 'en';
  return createTranslator({ lang, messages: bundles.get(lang) ?? {}, fallback: bundles.get('en') });
}

/** Stops the server (agents end as in a clean stop, SPEC 19) and leaves. `exit`, not `quit`: a ConPTY child can keep Node alive. */
async function shutdown(): Promise<void> {
  if (quitting) return;
  quitting = true;
  try { await server?.close(); } finally { app.exit(0); }
}

async function confirmThenShutdown(): Promise<void> {
  const running = server?.runningAgentCount() ?? 0;
  if (running > 0 && win) {
    const t = translator();
    const answer = await dialog.showMessageBox(win, {
      type: 'question', buttons: [t('app.quit.yes'), t('app.quit.no')], defaultId: 1, cancelId: 1, noLink: true,
      title: t('app.quit.title'), message: t('app.quit.title'), detail: t('app.quit.detail'),
    });
    if (answer.response !== 0) return;
  }
  await shutdown();
}

function createWindow(url: string, port: number): BrowserWindow {
  const w = new BrowserWindow({
    width: 1500, height: 950, minWidth: 900, minHeight: 600, show: false, autoHideMenuBar: true, backgroundColor: '#090b0e',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: !app.isPackaged, spellcheck: false, backgroundThrottling: true },
  });
  w.removeMenu(); // no menu bar: Alt+<digit> belongs to the page (SPEC 5.4)
  // Only the console's own origin is shown here; any other address goes to the user's browser.
  w.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target) && !isInternalUrl(target, port)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (event, target) => {
    if (isInternalUrl(target, port)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(target)) void shell.openExternal(target);
  });
  w.once('ready-to-show', () => w.show());
  w.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    void confirmThenShutdown();
  });
  void w.loadURL(url);
  return w;
}

async function start(): Promise<void> {
  await app.whenReady();
  try {
    server = await startServer({
      port: PORT, configDir: configDir(), ...(app.isPackaged ? { version: app.getVersion() } : {}),
      // The native folder window of Electron instead of a PowerShell one: one process less (the server's own picker is for the CLI).
      pickFolder: async (): Promise<PickFolderResult> => {
        const options = { title: translator()('folder.pick.title'), properties: ['openDirectory' as const] };
        const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
        const path = result.filePaths[0];
        return result.canceled || path === undefined ? { status: 'cancelled' } : { status: 'picked', path };
      },
    });
  } catch (e) {
    const t = translator();
    const busy = (e as NodeJS.ErrnoException).code === 'EADDRINUSE';
    dialog.showErrorBox('AndromedaCli', busy ? t('app.portBusy', { port: PORT }) : e instanceof Error ? e.message : String(e));
    app.exit(1);
    return;
  }
  win = createWindow(`${server.url}/?token=${server.token}`, server.port);
}

if (!app.requestSingleInstanceLock()) {
  app.quit(); // the console is already open: its window gets the focus (below), this start ends
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  // Quitting from outside the window (the system shutting down, a taskbar close) does not ask: the stop is the clean one.
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    void shutdown();
  });
  void start();
}
