/**
 * Puts a text into an element as formatted markdown. The libraries (marked and DOMPurify, about 75 KB) load the first time a text
 * needs them (SPEC 33.2); the plain text is shown at once and stays if they cannot be loaded.
 */
export function renderInto(el: HTMLElement, text: string): void {
  el.textContent = text;
  void import('./markdown').then((m) => { el.innerHTML = m.renderMarkdown(text); }).catch(() => { /* the plain text stays */ });
}
