import type { StateMessage } from '../shared/protocol';

/**
 * Stub left by the Options part: the notifications part owns this file and its version replaces this one at merge.
 * The tab shows nothing until then.
 */
export function renderNotificationsTab(container: HTMLElement, state: StateMessage): void {
  void state;
  container.replaceChildren();
}
