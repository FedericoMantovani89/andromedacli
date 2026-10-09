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
