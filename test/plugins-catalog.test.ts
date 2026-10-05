import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { notTestedWithInstalled, parseVersion, textFor, validatePlugins, type PluginEntry } from '../src/server/catalog/plugins';
import { autoClose, bootServer, req, ui } from './helpers';

autoClose();
const shipped = JSON.parse(readFileSync(join(__dirname, '..', 'catalog', 'plugins-catalog.json'), 'utf8'));

it('the shipped catalog validates completely, with the SPEC 30.4 tiers', () => {
  const doc = validatePlugins(shipped)!;
  expect(doc.plugins).toHaveLength(shipped.plugins.length);
  const tier = (t: string) => doc.plugins.filter((p) => p.tier === t).map((p) => p.id.split('@')[0]).sort();
  expect(tier('recommended')).toEqual(['jdtls-lsp', 'security-guidance', 'typescript-lsp']);
  expect(tier('on_request')).toEqual(['code-review', 'context7', 'frontend-design', 'plugin-dev']);
  expect(tier('discouraged')).toEqual(['commit-commands', 'feature-dev', 'github', 'pr-review-toolkit']);
  for (const p of doc.plugins) { expect(p.cost).toBeNull(); expect(p.testedWith).toBeNull(); }
});
it('drops invalid entries and never calls an unknown trust official', () => {
  const doc = validatePlugins({ plugins: [{ id: 'x' }, { id: 'y', tier: 'recommended', summary: { en: 'Y' }, trust: 'super' }] })!;
  expect(doc.plugins.map((p) => p.id)).toEqual(['y']);
  expect(doc.plugins[0]!.trust).toBe('unverified');
  expect(validatePlugins('nope')).toBeUndefined();
});
it('texts fall back to English', () => {
  expect(textFor({ en: 'A', it: 'B' }, 'it')).toBe('B');
  expect(textFor({ en: 'A' }, 'it')).toBe('A');
});
it('warns only when tested with an older Claude Code than the installed one', () => {
  const entry = (v: string | null) => ({ testedWith: v ? { claudeCode: v, date: null } : null }) as PluginEntry;
  expect(parseVersion('2.1.290 (Claude Code)')).toEqual([2, 1, 290]);
  expect(notTestedWithInstalled(entry('2.1.287'), '2.1.290')).toBe(true);
  expect(notTestedWithInstalled(entry('2.1.290'), '2.1.290')).toBe(false);
  expect(notTestedWithInstalled(entry('2.2.0'), '2.1.290')).toBe(false);
  expect(notTestedWithInstalled(entry(null), '2.1.290')).toBe(false);
  expect(notTestedWithInstalled(entry('2.1.287'), undefined)).toBe(false);
});
it('GET /api/plugins lists the catalog with the command to copy, and needs the token', async () => {
  const s = await bootServer();
  const r = await ui(s, '/api/plugins');
  expect(r.status).toBe(200);
  expect(r.body.source).toBe('shipped');
  const jd = r.body.plugins.find((p: any) => p.id.startsWith('jdtls-lsp'));
  expect(jd.installCommand).toBe('/plugin install jdtls-lsp@claude-plugins-official');
  expect(jd.notTested).toBe(false);
  expect((await req(s, '/api/plugins')).status).toBe(401);
});
