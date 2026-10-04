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
