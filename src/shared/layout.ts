/**
 * SPEC 5.1: up to `maxPanels` agents are full panels; the rest collapse to bars, a clicked bar expands in place of the last panel.
 * A `collapsed` agent (the user pressed Compact on its panel) is a bar and leaves its slot to the next agent; `expanded` wins over it.
 */
export function computeAgentLayout(
  slugs: string[], expanded: string | null, maxPanels = 4, collapsed: ReadonlySet<string> = new Set(),
): { slug: string; mode: 'panel' | 'bar' }[] {
  const panels = new Set(slugs.filter((s) => !collapsed.has(s)).slice(0, maxPanels));
  if (expanded && slugs.includes(expanded) && !panels.has(expanded)) {
    if (panels.size >= maxPanels) {
      const lastPanel = slugs.filter((s) => panels.has(s)).at(-1);
      if (lastPanel !== undefined) panels.delete(lastPanel);
    }
    panels.add(expanded);
  }
  return slugs.map((slug) => ({ slug, mode: panels.has(slug) ? 'panel' : 'bar' }));
}
