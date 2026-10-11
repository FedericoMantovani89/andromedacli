import { catalogSettings, mergeById, readShipped, RemoteCatalog, type CatalogSource, type TextFetcher } from './remote';
import type { Config } from '../config';

export interface ModelEntry { id: string; label: string }
export interface ModelsDoc { updated?: string; models: ModelEntry[] }
export interface ModelItem extends ModelEntry { alias?: true }

/** Same rule as `MODEL_RE` in agents/spawn.ts: the id becomes a command-line argument. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;
/** Aliases Claude Code accepts and keeps pointing at the newest model of the family: fixed in code, never in the catalog. */
export const MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'] as const;

/** Keeps the valid entries of a `models.json`; undefined when the file is not one. */
export function validateModels(raw: unknown): ModelsDoc | undefined {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { models?: unknown }).models)) return undefined;
  const models: ModelEntry[] = [];
  for (const m of (raw as { models: unknown[] }).models) {
    if (typeof m !== 'object' || m === null) continue;
    const { id, label } = m as { id?: unknown; label?: unknown };
    if (typeof id !== 'string' || !ID_RE.test(id) || id.length > 100) continue;
    models.push({ id, label: typeof label === 'string' && label.trim() !== '' && label.length <= 80 ? label : id });
  }
  const updated = (raw as { updated?: unknown }).updated;
  return { ...(typeof updated === 'string' && updated.length <= 40 ? { updated } : {}), models };
}

export interface ModelList { models: ModelItem[]; source: CatalogSource; updated?: string; current: string; missing: boolean }

/** The model menu of the Options dialog (SPEC 12): aliases, then the catalog; the saved choice stays selected even if it vanished. */
export class ModelCatalog {
  private readonly catalog: RemoteCatalog<ModelsDoc>;

  constructor(private readonly o: { configDir: string; config: () => Config['models']; fetch?: TextFetcher; now?: () => number }) {
    const shipped = validateModels(readShipped('models.json')) ?? { models: [] };
    this.catalog = new RemoteCatalog<ModelsDoc>({
      ...catalogSettings({ ...o, name: 'models' }), shipped, validate: validateModels,
      merge: (a, b) => ({ updated: b.updated ?? a.updated, models: mergeById(a.models, b.models) }),
      updatedOf: (d) => d.updated,
    });
  }

  /** The model every agent gets when nothing narrower says otherwise; undefined (no `--model`) when unset. */
  agentModel(): string | undefined { return this.o.config().agent || undefined; }

  async list(force = false): Promise<ModelList> {
    const { data, source, updated } = await this.catalog.load(force);
    const models: ModelItem[] = [
      ...MODEL_ALIASES.map((id) => ({ id, label: id, alias: true as const })),
      ...data.models.filter((m) => !(MODEL_ALIASES as readonly string[]).includes(m.id)),
    ];
    const current = this.o.config().agent;
    return { models, source, ...(updated !== undefined ? { updated } : {}), current, missing: current !== '' && !models.some((m) => m.id === current) };
  }
}
