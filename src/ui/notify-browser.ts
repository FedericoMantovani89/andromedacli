import type { NotificationsConfig, NotifyMessage } from '../shared/notify';

/** The tab title with the number of things waiting for the user in front: "(2) AndromedaCli v0.0.1". */
export function titleWithCount(title: string, waiting: number): string {
  const base = title.replace(/^\(\d+\)\s+/, '');
  return waiting > 0 ? `(${waiting}) ${base}` : base;
}

/**
 * The fallback when the server cannot show a native toast (SPEC 20.5): a browser notification, only if the user turned it on in the
 * Notifications tab, the permission was granted there, and the tab is not the one in front.
 */
export function showBrowserNotification(msg: NotifyMessage, config: NotificationsConfig | undefined, tabInFront: boolean): boolean {
  if (!config?.browserFallback || tabInFront) return false;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  try {
    new Notification(msg.title, { body: msg.message, tag: msg.id });
    return true;
  } catch {
    return false;
  }
}
