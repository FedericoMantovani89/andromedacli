/**
 * The start-up picture (see #splash in index.html): shown for a moment, faded out, then taken out of the layout. It never takes
 * clicks or keys (pointer-events: none), so the keyboard goes where it would have gone anyway.
 */
export function runSplash(showMs = 1800, fadeMs = 600): void {
  const el = document.getElementById('splash');
  if (!el) return;
  setTimeout(() => {
    el.classList.add('fade');
    setTimeout(() => { el.hidden = true; }, fadeMs);
  }, showMs);
}
