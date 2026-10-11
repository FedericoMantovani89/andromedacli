import { catalogSettings, mergeById, readShipped, RemoteCatalog, type CatalogSource, type TextFetcher } from './remote';
import type { Config } from '../config';
import { isObj } from '../../shared/guards';

export const PLUGIN_TIERS = ['recommended', 'on_request', 'discouraged'] as const;
export const PLUGIN_TRUSTS = ['official', 'community', 'demonstrative', 'unverified'] as const;
/** A text with one version per language (the English one is always there). */
export type PerLanguage = { en: string } & Record<string, string>;

export interface PluginEntry {
  id: string;
  category: string;
  summary: PerLanguage;
  trust: (typeof PLUGIN_TRUSTS)[number];
  tier: (typeof PLUGIN_TIERS)[number];
  appliesTo: string[];
  defaultFor: string[];
  requires: string[];
  agentsAllowed: boolean;
  conflicts: PerLanguage[];
  /** null: not measured (shown as n/a). */
  cost: { contextTokens: number | null; note?: string } | null;
  testedWith: { claudeCode: string | null; date: string | null } | null;
  source?: string;
}
export interface MarketplaceEntry { id: string; trust: PluginEntry['trust']; add?: string }
export interface PluginsDoc { schema: 1; updated?: string; marketplaces: (MarketplaceEntry & { id: string })[]; plugins: PluginEntry[] }

const str = (v: unknown, max = 400): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => str(x, 100)) : []);
function perLanguage(v: unknown): PerLanguage | undefined {
  if (!isObj(v) || !str(v.en)) return undefined;
  const out: Record<string, string> = {};
  for (const [lang, text] of Object.entries(v)) if (/^[a-z]{2,3}$/.test(lang) && str(text)) out[lang] = text;
  return out as PerLanguage;
}

function validateEntry(raw: unknown): PluginEntry | undefined {
  if (!isObj(raw) || !str(raw.id, 120)) return undefined;
  const summary = perLanguage(raw.summary);
  const tier = PLUGIN_TIERS.find((t) => t === raw.tier);
  if (!summary || !tier) return undefined;
  const trust = PLUGIN_TRUSTS.find((t) => t === raw.trust) ?? 'unverified'; // unknown is never "official"
  const cost = isObj(raw.cost)
    ? { contextTokens: typeof raw.cost.contextTokens === 'number' && raw.cost.contextTokens >= 0 ? raw.cost.contextTokens : null, ...(str(raw.cost.note) ? { note: raw.cost.note } : {}) }
    : null;
  const tw = isObj(raw.testedWith) ? { claudeCode: str(raw.testedWith.claudeCode, 40) ? raw.testedWith.claudeCode : null, date: str(raw.testedWith.date, 40) ? raw.testedWith.date : null } : null;
  const conflicts = Array.isArray(raw.conflicts) ? raw.conflicts.map(perLanguage).filter((c): c is PerLanguage => c !== undefined) : [];
  return {
    id: raw.id, category: str(raw.category, 60) ? raw.category : 'other', summary, trust, tier,
    appliesTo: strings(raw.appliesTo), defaultFor: strings(raw.defaultFor), requires: strings(raw.requires),
    agentsAllowed: raw.agentsAllowed !== false, conflicts, cost, testedWith: tw,
    ...(str(raw.source, 300) ? { source: raw.source } : {}),
  };
}

/** Keeps the valid entries of a `plugins-catalog.json`; undefined when the file is not one. */
export function validatePlugins(raw: unknown): PluginsDoc | undefined {
  if (!isObj(raw) || !Array.isArray(raw.plugins)) return undefined;
  const plugins = raw.plugins.map(validateEntry).filter((p): p is PluginEntry => p !== undefined);
  const marketplaces: PluginsDoc['marketplaces'] = [];
  for (const m of Array.isArray(raw.marketplaces) ? raw.marketplaces : []) {
    if (!isObj(m) || !str(m.id, 100)) continue;
    marketplaces.push({ id: m.id, trust: PLUGIN_TRUSTS.find((t) => t === m.trust) ?? 'unverified', ...(str(m.add, 200) ? { add: m.add } : {}) });
  }
  return { schema: 1, ...(str(raw.updated, 40) ? { updated: raw.updated } : {}), marketplaces, plugins };
}

/** The text in the user's language, else English. */
export function textFor(text: PerLanguage, lang: string): string { return text[lang] ?? text.en; }

/** The numbers of "2.1.290" or "claude 2.1.290 (Claude Code)"; undefined when there are none. */
export function parseVersion(s: string | null | undefined): number[] | undefined {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(s ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
}

/** SPEC 30.8: tested with an older Claude Code than the installed one. Unknown on either side means no warning (it is shown as n/a). */
export function notTestedWithInstalled(entry: PluginEntry, installed: string | null | undefined): boolean {
  const tested = parseVersion(entry.testedWith?.claudeCode);
  const now = parseVersion(installed);
  if (!tested || !now) return false;
  for (let i = 0; i < 3; i++) if (tested[i]! !== now[i]!) return tested[i]! < now[i]!;
  return false;
}

export interface PluginList extends PluginsDoc { source: CatalogSource; plugins: (PluginEntry & { notTested: boolean; installCommand: string })[] }

/** The plugin catalog as a list to read (SPEC 30): nothing is installed or enabled from here. */
export class PluginCatalog {
  private readonly catalog: RemoteCatalog<PluginsDoc>;

  constructor(o: { configDir: string; config: () => Config['plugins']; fetch?: TextFetcher; now?: () => number }) {
    const shipped = validatePlugins(readShipped('plugins-catalog.json')) ?? { schema: 1 as const, marketplaces: [], plugins: [] };
    this.catalog = new RemoteCatalog<PluginsDoc>({
      ...catalogSettings({ ...o, name: 'plugins' }), shipped, validate: validatePlugins,
      merge: (a, b) => ({ schema: 1, updated: b.updated ?? a.updated, marketplaces: mergeById(a.marketplaces, b.marketplaces), plugins: mergeById(a.plugins, b.plugins) }),
      updatedOf: (d) => d.updated,
    });
  }

  async list(installedClaude: string | undefined, force = false): Promise<PluginList> {
    const { data, source } = await this.catalog.load(force);
    return { ...data, source, plugins: data.plugins.map((p) => ({ ...p, notTested: notTestedWithInstalled(p, installedClaude), installCommand: `/plugin install ${p.id}` })) };
  }
}
