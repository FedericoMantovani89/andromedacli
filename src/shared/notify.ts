/** Notification types and settings shared by the server and the Notifications tab (SPEC 20). Codes are English constants. */
export const NOTIFY_TYPES = ['question', 'permission', 'release', 'ticket_stuck', 'budget', 'weekly_limit', 'decision', 'interrupted'] as const;
export type NotifyType = (typeof NOTIFY_TYPES)[number];

export interface NotificationsConfig {
  enabled: Record<NotifyType, boolean>;
  /** Local time, 'HH:MM'; the window may cross midnight. */
  quietHours: { enabled: boolean; from: string; to: string };
  sound: boolean;
  /** Events closer than this are one toast (1-60). */
  groupSeconds: number;
  /** Also show a browser notification when no toast can be sent and the tab is not focused. */
  browserFallback: boolean;
}

/** `unknown` until the first availability check or send. */
export type ToastStatus = 'ok' | 'unavailable' | 'unknown';

export const DEFAULT_NOTIFICATIONS: NotificationsConfig = {
  enabled: { question: true, permission: true, release: true, ticket_stuck: true, budget: true, weekly_limit: true, decision: true, interrupted: true },
  quietHours: { enabled: false, from: '22:00', to: '07:00' },
  sound: true,
  groupSeconds: 5,
  browserFallback: false,
};

/** What the UI reports about itself (POST /api/presence). */
export interface PresenceReport { focused: boolean; visible: boolean; drawerOpen: boolean; active: string }

/** The JSON message pushed on /ws/ui when no toast can be shown. */
export interface NotifyMessage { type: 'notify'; id: string; title: string; message: string }
