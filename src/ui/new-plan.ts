import type { StateMessage } from '../shared/protocol';

/**
 * Stub left by the Options part: the templates part owns this file (the new-plan dialog and the "save as template" dialog) and its
 * version replaces this one at merge. The button in Options > Plans calls this and does nothing until then.
 */
export function openSaveTemplateDialog(getState: () => StateMessage | undefined): void {
  void getState;
}
