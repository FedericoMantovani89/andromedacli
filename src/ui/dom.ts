import { bindText } from './i18n-client';

/**
 * Makes `parent`'s children equal `desired` while moving as few nodes as possible. Re-parenting a node makes the
 * browser drop its keyboard focus, so a state update must never shuffle the node the user is typing in (P2).
 */
export function reconcile(parent: HTMLElement, desired: HTMLElement[]): void {
  // Remove what no longer belongs first: a replaced element would otherwise sit in the middle and push every later node
  // (a form the user may be typing in) out of place.
  const keep = new Set(desired);
  for (const child of [...parent.children]) if (!keep.has(child as HTMLElement)) child.remove();
  desired.forEach((child, i) => {
    if (parent.children[i] !== child) parent.insertBefore(child, parent.children[i] ?? null);
  });
}

/** `document.createElement` with an optional class: the one element builder of the UI. */
export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
};

/** Buttons that must not take the keyboard from where it is (answering from the queue never moves the focus). */
export function keepFocus(button: HTMLElement): void {
  button.addEventListener('mousedown', (ev) => ev.preventDefault());
}

/** A switch row: a checkbox and its label (the label key is translated, and again when the language changes). */
export function checkbox(name: string | undefined, labelKey: string): { row: HTMLLabelElement; input: HTMLInputElement } {
  const row = el('label', 'settings-switch');
  const input = el('input');
  input.type = 'checkbox';
  if (name) input.name = name;
  const text = el('span');
  bindText(text, labelKey);
  row.append(input, text);
  return { row, input };
}

/** Shows `children` in a dialog over the page (Escape closes it) and returns the dialog; `extraClass` adds to the `dialog` class. */
export function showDialog(children: Node[], extraClass?: string): HTMLElement {
  const dialog = el('div', extraClass ? `dialog ${extraClass}` : 'dialog');
  dialog.dataset.escape = '';
  dialog.append(...children);
  const overlay = document.getElementById('overlay')!;
  overlay.replaceChildren(dialog);
  overlay.hidden = false;
  return dialog;
}
