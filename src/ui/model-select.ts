import { api } from './api';
import { bindText } from './i18n-client';
import { el } from './dom';

export interface ModelEntry { id: string; label: string; alias?: true }

/**
 * Fills a model menu: the "default" entry first (its text is the key given), then the catalog's real models (never an alias), then, when
 * `current` is a model the catalog does not list, that one too: the choice is the user's, so it stays selected. Used by Options, Models,
 * the project's model and the model of a profile, so all of them offer the same list.
 */
export function fillModelSelect(select: HTMLSelectElement, models: readonly ModelEntry[], current: string, defaultKey: string): void {
  select.replaceChildren();
  const add = (value: string): HTMLOptionElement => {
    const o = el('option');
    o.value = value;
    select.append(o);
    return o;
  };
  bindText(add(''), defaultKey);
  const ids = new Set<string>();
  for (const m of models) {
    if (m.alias) continue;
    add(m.id).textContent = m.label;
    ids.add(m.id);
  }
  if (current !== '' && !ids.has(current)) add(current).textContent = current;
  select.value = current;
}

/** Shows the menu with only the default and `current` at once, then with the catalog when `GET /api/models` answers. */
export function loadModelSelect(select: HTMLSelectElement, current: string, defaultKey: string): void {
  fillModelSelect(select, [], current, defaultKey);
  void api<{ models: ModelEntry[] }>('/api/models').then((res) => {
    if (res.status === 200) fillModelSelect(select, res.body.models, select.value, defaultKey);
  });
}
