import { DEFAULT_NOTIFICATIONS, NOTIFY_TYPES, type NotificationsConfig, type NotifyType } from '../shared/notify';
import type { ApiError, StateMessage } from '../shared/protocol';
import { api } from './api';
import { bindText, k } from './i18n-client';
import { errorText } from './new-agent';
import { FIELD_LABELS } from './options';
import { attachClock } from './time-picker';

/**
 * The Notifications tab (SPEC 20.4, 22.2): which events notify, quiet hours, sound, grouping, the browser fallback, a test toast and
 * whether a toast can be shown at all. Changes are staged and sent by the dialog's Save through PUT /api/config; they apply to the next event.
 */
export function renderNotificationsTab(container: HTMLElement, state: StateMessage, stage: (key: string, run: (dry: boolean) => Promise<{ status: number; body: unknown }>) => void): void {
  const config: NotificationsConfig = structuredClone(state.notifications?.config ?? DEFAULT_NOTIFICATIONS);
  container.replaceChildren();
  const box = document.createElement('div');
  box.className = 'settings-agents settings-notifications';
  const error = document.createElement('div');
  error.className = 'form-error';

  /** Stages one part of the settings for the dialog's Save; a later change of the same setting replaces it. */
  const save = (patch: Record<string, unknown>): void => {
    const path: string[] = [];
    for (let cur: unknown = patch; typeof cur === 'object' && cur !== null; ) {
      const [key, next] = Object.entries(cur)[0] ?? [];
      if (key === undefined) break;
      path.push(key);
      cur = next;
    }
    stage(`notifications:${path.join('.')}`, (dry) => api<ApiError>(dry ? '/api/config?dryRun=1' : '/api/config', { method: 'PUT', body: { notifications: patch } }));
  };

  // One switch per event type.
  const typesTitle = document.createElement('p');
  typesTitle.className = 'settings-note';
  bindText(typesTitle, 'settings.notifications.types');
  box.append(typesTitle);
  for (const type of NOTIFY_TYPES) {
    const row = document.createElement('label');
    row.className = 'settings-switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = `type-${type}`;
    input.checked = config.enabled[type];
    const text = document.createElement('span');
    bindText(text, `settings.notifications.type.${type}`);
    input.addEventListener('change', () => {
      const wanted = input.checked;
      config.enabled[type as NotifyType] = wanted;
      save({ enabled: { [type]: wanted } });
    });
    row.append(input, text);
    box.append(row);
  }

  // Quiet hours: a switch and two local times (the window may cross midnight).
  const quietRow = document.createElement('label');
  quietRow.className = 'settings-switch';
  const quiet = document.createElement('input');
  quiet.type = 'checkbox';
  quiet.name = 'quietEnabled';
  quiet.checked = config.quietHours.enabled;
  const quietText = document.createElement('span');
  bindText(quietText, 'settings.notifications.quiet');
  quietRow.append(quiet, quietText);
  quiet.addEventListener('change', () => {
    const wanted = quiet.checked;
    save({ quietHours: { enabled: wanted } });
    syncTimes();
  });
  const times = document.createElement('div');
  times.className = 'settings-switch';
  const timeInput = (name: 'from' | 'to', key: string): HTMLElement => {
    const label = document.createElement('div'); // not a <label>: a click on the text would press the clock button a second time
    label.className = 'settings-switch';
    const text = document.createElement('span');
    bindText(text, key);
    const input = document.createElement('input');
    input.name = `quiet-${name}`;
    input.value = config.quietHours[name];
    let saved = input.value;
    input.addEventListener('change', () => {
      const wanted = input.value;
      if (wanted === '') { input.value = saved; return; } // a cleared time is not a time
      save({ quietHours: { [name]: wanted } });
      saved = wanted;
    });
    label.append(text, attachClock(input, key)); // the clock face picks the time; `input` (hidden) keeps it and fires `change`
    return label;
  };
  times.append(timeInput('from', k('settings.notifications.quietFrom')), timeInput('to', k('settings.notifications.quietTo')));
  // The times only matter while quiet hours are on: with the box off the two clocks are disabled (and dimmed).
  function syncTimes(): void {
    times.classList.toggle('is-off', !quiet.checked);
    for (const b of times.querySelectorAll('button')) b.disabled = !quiet.checked;
  }
  syncTimes();

  const soundRow = document.createElement('label');
  soundRow.className = 'settings-switch';
  const soundInput = document.createElement('input');
  soundInput.type = 'checkbox';
  soundInput.name = 'sound';
  soundInput.checked = config.sound;
  const soundText = document.createElement('span');
  bindText(soundText, 'settings.notifications.sound');
  soundRow.append(soundInput, soundText);
  soundInput.addEventListener('change', () => {
    const wanted = soundInput.checked;
    save({ sound: wanted });
  });

  const groupLabel = document.createElement('label');
  groupLabel.className = 'settings-switch';
  const groupText = document.createElement('span');
  bindText(groupText, 'settings.notifications.group');
  const group = document.createElement('input');
  group.type = 'number';
  group.name = 'groupSeconds';
  group.min = '1';
  group.max = '60';
  group.value = String(config.groupSeconds);
  FIELD_LABELS.set('notifications.groupSeconds', 'settings.notifications.group');
  // Whatever is typed is staged: Save asks the server, which refuses a value out of range and the message names the field and its limits.
  group.addEventListener('change', () => save({ groupSeconds: Number(group.value) }));
  groupLabel.append(groupText, group);

  // The browser fallback: the permission is asked on this click only.
  const browserRow = document.createElement('label');
  browserRow.className = 'settings-switch';
  const browser = document.createElement('input');
  browser.type = 'checkbox';
  browser.name = 'browserFallback';
  browser.checked = config.browserFallback;
  const browserText = document.createElement('span');
  bindText(browserText, 'settings.notifications.browser');
  browserRow.append(browser, browserText);
  browser.addEventListener('change', () => {
    const wanted = browser.checked;
    void (async () => {
      if (wanted) {
        let granted = false;
        try { granted = typeof Notification !== 'undefined' && (Notification.permission === 'granted' || (await Notification.requestPermission()) === 'granted'); } catch { granted = false; }
        if (!granted) { browser.checked = false; return; }
      }
      save({ browserFallback: wanted });
    })();
  });
  const browserHelp = document.createElement('p');
  browserHelp.className = 'settings-note';
  bindText(browserHelp, 'settings.notifications.browser.help');

  // The test toast and what is known about toasts on this machine.
  const status = document.createElement('div');
  status.className = 'settings-note settings-toast-status';
  const showToast = (toast: 'ok' | 'unavailable' | 'unknown'): void => {
    // Unknown is shown as n/a, never as "ok" (P7).
    bindText(status, toast === 'ok' ? k('settings.notifications.toast.ok') : toast === 'unavailable' ? k('settings.notifications.toast.unavailable') : k('settings.notifications.toast.unknown'));
  };
  showToast(state.notifications?.toast ?? 'unknown');
  const test = document.createElement('button');
  test.type = 'button';
  test.name = 'testToast';
  bindText(test, 'settings.notifications.test');
  const result = document.createElement('span');
  result.className = 'settings-note';
  test.addEventListener('click', () => {
    void api<{ ok: boolean }>('/api/notifications/test', { method: 'POST' }).then((res) => {
      const ok = res.status === 200 && res.body.ok === true;
      bindText(result, ok ? k('settings.notifications.testSent') : k('settings.notifications.testFailed'));
      showToast(ok ? 'ok' : 'unavailable');
    });
  });
  const testRow = document.createElement('div');
  testRow.className = 'settings-switch';
  testRow.append(test, result);

  box.append(quietRow, times, soundRow, groupLabel, browserRow, browserHelp, status, testRow, error);
  container.append(box);
}
