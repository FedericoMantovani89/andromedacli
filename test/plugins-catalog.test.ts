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
  expect(tier('on_request')).toEqual(['code-review', 'context7', 'frontend-design', 'plugin-dev', 'superpowers']);
  expect(tier('discouraged')).toEqual(['commit-commands', 'feature-dev', 'github', 'pr-review-toolkit']);
  for (const p of doc.plugins) { expect(p.cost).toBeNull(); expect(p.testedWith).toBeNull(); }
  const sp = doc.plugins.find((p) => p.id === 'superpowers@claude-plugins-official')!;
  expect(sp).toMatchObject({ trust: 'official', agentsAllowed: false }); // the console, not the skills, makes worktrees and commits: for the main only
  expect(sp.conflicts).toHaveLength(1);
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

// Which plugins are installed: asked of Claude Code (`claude plugin list --json`), never read from its folders.
import { parseInstalled, readInstalled, statusOf, type InstalledPlugin } from '../src/server/catalog/installed';
import { goodRunner } from './helpers';

const here = process.platform === 'win32' ? 'D:\work\shop' : '/work/shop';
const elsewhere = process.platform === 'win32' ? 'D:\work\other' : '/work/other';
const list: InstalledPlugin[] = [
  { id: 'a@m', scope: 'user', enabled: true, version: '1.0' },
  { id: 'b@m', scope: 'local', enabled: true, version: '2.0', projectPath: here },
  { id: 'c@m', scope: 'local', enabled: true, version: '3.0', projectPath: elsewhere },
  { id: 'd@m', scope: 'user', enabled: false, version: '4.0' },
  { id: 'e@m', scope: 'local', enabled: false, projectPath: here },
  { id: 'f@m', scope: 'local', enabled: false, version: '5.0', projectPath: here },
  { id: 'f@m', scope: 'user', enabled: true, version: '5.1' },
];
it('statusOf: installed for every project, for this one, switched off, only elsewhere, or not at all', () => {
  expect(statusOf('a@m', list, here)).toEqual({ state: 'installed', version: '1.0' });
  expect(statusOf('b@m', list, here)).toEqual({ state: 'project', version: '2.0' });
  expect(statusOf('c@m', list, here)).toEqual({ state: 'other_project' });
  expect(statusOf('d@m', list, here)).toEqual({ state: 'disabled', version: '4.0' });
  expect(statusOf('e@m', list, here)).toEqual({ state: 'disabled' });
  expect(statusOf('f@m', list, here)).toEqual({ state: 'installed', version: '5.1' }); // an enabled copy wins over a disabled one
  expect(statusOf('zzz@m', list, here)).toEqual({ state: 'not_installed' });
  expect(statusOf('c@m', list, elsewhere)).toEqual({ state: 'project', version: '3.0' });
});
it('parseInstalled keeps the valid lines and says nothing for output that is not a list', () => {
  expect(parseInstalled(JSON.stringify([{ id: 'a@m', scope: 'user', enabled: true }, { id: 3 }, 'x']))).toEqual([{ id: 'a@m', scope: 'user', enabled: true }]);
  expect(parseInstalled('2.1.289 (Claude Code)')).toBeUndefined();
  expect(parseInstalled('{}')).toBeUndefined();
});
it('readInstalled runs the configured command with `plugin list --json`; a failure is null (unknown), never an empty list', async () => {
  const calls: string[] = [];
  const out = await readInstalled(['node', 'cli.js'], async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { code: 0, stdout: JSON.stringify([{ id: 'a@m', scope: 'user', enabled: true }]) }; });
  expect(calls).toEqual(['node cli.js plugin list --json']);
  expect(out).toHaveLength(1);
  expect(await readInstalled(['claude'], async () => ({ code: 1, stdout: '' }))).toBeNull();
  expect(await readInstalled(['claude'], async () => { throw new Error('ENOENT'); })).toBeNull();
  expect(await readInstalled(['claude'], async () => ({ code: 0, stdout: 'not json' }))).toBeNull();
});
it('GET /api/plugins/installed gives a state for every catalog plugin, or null when Claude Code cannot tell', async () => {
  const s = await bootServer({ runner: async (cmd, args) => (args.includes('plugin') ? { code: 0, stdout: JSON.stringify([{ id: 'context7@claude-plugins-official', scope: 'user', enabled: true, version: '1.2.3' }]) } : goodRunner(cmd, args, 1000)) });
  const r = await ui(s, '/api/plugins/installed');
  expect(r.status).toBe(200);
  expect(r.body.installed['context7@claude-plugins-official']).toEqual({ state: 'installed', version: '1.2.3' });
  expect(r.body.installed['jdtls-lsp@claude-plugins-official']).toEqual({ state: 'not_installed' });
  expect((await req(s, '/api/plugins/installed')).status).toBe(401);
  const unknown = await bootServer(); // the default fake runner prints a version, not a list
  expect((await ui(unknown, '/api/plugins/installed')).body).toEqual({ installed: null });
});
