/** SPEC 5.1: up to `maxPanels` agents are full panels; the rest collapse to bars, a clicked bar expands in place of the last panel. */
export function computeAgentLayout(
  slugs: string[], expanded: string | null, maxPanels = 4,
): { slug: string; mode: 'panel' | 'bar' }[] {
  const panels = new Set(slugs.slice(0, maxPanels));
  if (expanded && slugs.includes(expanded) && !panels.has(expanded)) {
    const lastPanel = slugs.slice(0, maxPanels).at(-1);
    if (lastPanel !== undefined) panels.delete(lastPanel);
    panels.add(expanded);
  }
  return slugs.map((slug) => ({ slug, mode: panels.has(slug) ? 'panel' : 'bar' }));
}
