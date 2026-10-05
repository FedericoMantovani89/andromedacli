import { DEFAULT_NOTIFICATIONS, NOTIFY_TYPES, type NotificationsConfig, type NotifyType } from '../shared/notify';
import type { ApiError, StateMessage } from '../shared/protocol';
import { api } from './api';
import { bindText, k } from './i18n-client';
import { errorText } from './new-agent';

/**
 * The Notifications tab (SPEC 20.4, 22.2): which events notify, quiet hours, sound, grouping, the browser fallback, a test toast and
 * whether a toast can be shown at all. Every change is saved at once through PUT /api/config and applies to the next event.
 */
export function renderNotificationsTab(container: HTMLElement, state: StateMessage): void {
  const config: NotificationsConfig = structuredClone(state.notifications?.config ?? DEFAULT_NOTIFICATIONS);
  container.replaceChildren();
  const box = document.createElement('div');
  box.className = 'settings-agents settings-notifications';
  const error = document.createElement('div');
  error.className = 'form-error';

  /** Saves one part of the settings; `undo` puts the control back when the server refuses (a switch must not show what is not real). */
  const save = (patch: Record<string, unknown>, undo: () => void): void => {
    void api<ApiError>('/api/config', { method: 'PUT', body: { notifications: patch } }).then((res) => {
      if (res.status === 200) { error.textContent = ''; return; }
      error.textContent = errorText(res.body);
      undo();
    });
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
      save({ enabled: { [type]: wanted } }, () => { input.checked = !wanted; config.enabled[type as NotifyType] = !wanted; });
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
    save({ quietHours: { enabled: wanted } }, () => { quiet.checked = !wanted; });
  });
  const times = document.createElement('div');
  times.className = 'settings-switch';
  const timeInput = (name: 'from' | 'to', key: string): HTMLElement => {
    const label = document.createElement('label');
    label.className = 'settings-switch';
    const text = document.createElement('span');
    bindText(text, key);
    const input = document.createElement('input');
    input.type = 'time';
    input.name = `quiet-${name}`;
    input.value = config.quietHours[name];
    let saved = input.value;
    input.addEventListener('change', () => {
      const wanted = input.value;
      if (wanted === '') { input.value = saved; return; } // a cleared time is not a time
      save({ quietHours: { [name]: wanted } }, () => { input.value = saved; });
      saved = wanted;
    });
    label.append(text, input);
    return label;
  };
  times.append(timeInput('from', k('settings.notifications.quietFrom')), timeInput('to', k('settings.notifications.quietTo')));

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
    save({ sound: wanted }, () => { soundInput.checked = !wanted; });
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
  let savedGroup = group.value;
  group.addEventListener('change', () => {
    const wanted = Number(group.value);
    const was = savedGroup;
    save({ groupSeconds: wanted }, () => { group.value = was; });
    savedGroup = String(wanted);
  });
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
      save({ browserFallback: wanted }, () => { browser.checked = !wanted; });
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
