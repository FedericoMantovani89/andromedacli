import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { findTemplate, loadTemplates, validateTemplate } from '../src/server/templates/load';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'tpl-load-'));

const valid = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 1, id, name: { en: `Name ${id}`, it: `Nome ${id}` }, description: { en: 'd', it: 'd' }, ...extra,
});
function put(root: string, id: string, json: unknown, raw = false): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'template.json'), raw ? String(json) : JSON.stringify(json));
  return dir;
}

it('the three shipped templates are valid and carry what the design says', () => {
  const all = loadTemplates({ configDir: tmp() });
  expect(all.map((t) => t.id)).toEqual(['backend-java', 'frontend-web', 'generic']);
  for (const t of all) {
    expect(t.valid, `${t.id}: ${t.reason}`).toBe(true);
    expect(t.source).toBe('shipped');
    expect(t.data!.name.en!.length).toBeGreaterThan(2);
    expect(t.data!.name.it!.length).toBeGreaterThan(2);
  }
  const java = all.find((t) => t.id === 'backend-java')!.data!;
  expect(java.profiles).toEqual(['backend', 'dba']);
  expect(java.docs).toEqual(['README.md', 'CHANGELOG.md']);
  expect(all.find((t) => t.id === 'frontend-web')!.data!.profiles).toEqual(['frontend']);
  expect(all.find((t) => t.id === 'generic')!.data!.profiles).toBeUndefined(); // no restriction: every shipped profile is offered
});

it('defaults: detect is on, commands and docs are empty', () => {
  const r = validateTemplate(valid('plain-one'), 'plain-one');
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.data).toMatchObject({ detect: true, commands: {}, docs: [], git: {}, defaults: {} });
});

it('an invalid file makes the template unavailable with the reason, and never throws', () => {
  const shipped = tmp();
  put(shipped, 'bad-json', '{not json', true);
  put(shipped, 'wrong-id', valid('other-id'));
  put(shipped, 'no-name', { schema: 1, id: 'no-name', description: { en: 'd' } });
  put(shipped, 'bad-command', valid('bad-command', { commands: { test: 'a\nb' } }));
  put(shipped, 'bad-profile', valid('bad-profile', { profiles: ['nonsense'] }));
  put(shipped, 'bad-defaults', valid('bad-defaults', { defaults: { maxActive: 0 } }));
  mkdirSync(join(shipped, 'empty-folder'));
  const all = loadTemplates({ configDir: tmp(), shippedDir: shipped });
  expect(all).toHaveLength(7);
  for (const t of all) {
    expect(t.valid, t.id).toBe(false);
    expect(t.reason, t.id).toBeTruthy();
    expect(t.data).toBeUndefined();
  }
  expect(all.find((t) => t.id === 'empty-folder')!.reason).toMatch(/missing/);
});

it('folders that are not slugs are not templates', () => {
  const shipped = tmp();
  put(shipped, 'Not_A_Slug', valid('Not_A_Slug'));
  expect(loadTemplates({ configDir: tmp(), shippedDir: shipped })).toEqual([]);
  expect(findTemplate('../x', { configDir: tmp(), shippedDir: shipped })).toBeUndefined();
});

it('the user template wins over the shipped one with the same id; the others stay', () => {
  const shipped = tmp();
  const config = tmp();
  put(shipped, 'shared-id', valid('shared-id', { commands: { test: 'shipped test' } }));
  put(shipped, 'only-shipped', valid('only-shipped'));
  put(join(config, 'templates'), 'shared-id', valid('shared-id', { commands: { test: 'user test' } }));
  put(join(config, 'templates'), 'only-user', valid('only-user'));
  const all = loadTemplates({ configDir: config, shippedDir: shipped });
  expect(all.map((t) => `${t.id}:${t.source}`)).toEqual(['only-shipped:shipped', 'only-user:user', 'shared-id:user']);
  expect(findTemplate('shared-id', { configDir: config, shippedDir: shipped })!.data!.commands.test).toBe('user test');
});

it('a template with every field is read as written', () => {
  const shipped = tmp();
  put(shipped, 'full-one', valid('full-one', {
    profiles: ['backend'], commands: { build: ' make ', test: 'make test', lint: '' }, git: { squash: false, secretPatterns: ['*.vault'] },
    docs: ['README.md'], defaults: { model: 'opus', agentTokens: 5000, maxActive: 2 }, detect: false,
  }));
  const t = findTemplate('full-one', { configDir: tmp(), shippedDir: shipped })!;
  expect(t.valid).toBe(true);
  expect(t.data).toMatchObject({
    profiles: ['backend'], commands: { build: 'make', test: 'make test' }, git: { squash: false, secretPatterns: ['*.vault'] },
    docs: ['README.md'], defaults: { model: 'opus', agentTokens: 5000, maxActive: 2 }, detect: false,
  });
  expect(t.data!.commands.lint).toBeUndefined();
});
