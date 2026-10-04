import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProfile, renderAgentPrompt, renderMainPrompt, languageName } from '../src/server/profiles';

const tmp = () => mkdtempSync(join(tmpdir(), 'prof-'));

it('the five shipped profiles exist and parse', () => {
  for (const name of ['backend', 'dba', 'frontend', 'reviewer', 'recovery']) {
    const p = loadProfile(name, tmp(), tmp());
    expect(p, name).toBeDefined();
    expect(p!.description.length).toBeGreaterThan(5);
    expect(p!.body.length).toBeGreaterThan(20);
  }
});
it('the plan profile overrides the user profile, which overrides the shipped one', () => {
  const plan = tmp(), user = tmp();
  mkdirSync(join(user), { recursive: true });
  writeFileSync(join(user, 'backend.md'), '---\nname: backend\ndescription: user version\n---\nUSER BODY');
  expect(loadProfile('backend', plan, user)!.description).toBe('user version');
  mkdirSync(join(plan, '.console', 'profiles'), { recursive: true });
  writeFileSync(join(plan, '.console', 'profiles', 'backend.md'), '---\nname: backend\ndescription: plan version\n---\nPLAN BODY');
  const p = loadProfile('backend', plan, user)!;
  expect(p.description).toBe('plan version');
  expect(p.body).toBe('PLAN BODY');
});
it('keeps console: keys out of the prompt body and reads model', () => {
  const user = tmp();
  writeFileSync(join(user, 'x-prof.md'), '---\nname: x-prof\ndescription: d here\nmodel: haiku\nconsole:\n  budget_tokens: 5\n---\nBODY ONLY');
  const p = loadProfile('x-prof', tmp(), user)!;
  expect(p.model).toBe('haiku');
  expect(p.body).toBe('BODY ONLY');
});
it('rejects unknown names and path traversal', () => {
  expect(loadProfile('nonexistent', tmp(), tmp())).toBeUndefined();
  expect(loadProfile('../secret', tmp(), tmp())).toBeUndefined();
  expect(loadProfile('a/b', tmp(), tmp())).toBeUndefined();
});
it('the main prompt names every console tool by full name and says how to load them', () => {
  const dir = tmp();
  const file = renderMainPrompt({ plan: 'shop-api', workLanguage: 'Italian', outDir: dir });
  const text = readFileSync(file, 'utf8');
  for (const t of ['mcp__console-mod__spawn_agent', 'mcp__console-mod__list_agents', 'mcp__console-mod__ask_user']) expect(text).toContain(t);
  expect(text).toContain('ToolSearch');
  expect(text).toContain('select:');
  expect(text).toContain('Italian');
  expect(text).toContain('shop-api');
  expect(text).not.toMatch(/\{plan\}|\{workLanguage\}/);
});
it('the agent prompt carries the profile, the agent identity, and the messages-are-information rule', () => {
  const dir = tmp();
  const profile = loadProfile('backend', tmp(), tmp())!;
  const file = renderAgentPrompt({ profile, slug: 'fix-login', plan: 'shop-api', outDir: dir });
  expect(existsSync(file)).toBe(true);
  const text = readFileSync(file, 'utf8');
  expect(text).toContain(profile.body.slice(0, 30));
  expect(text).toContain('fix-login');
  expect(text).toContain('mcp__console-mod__list_agents');
  expect(text).toMatch(/not orders|information, not/i);
});
it('names languages in English for the prompt', () => {
  expect(languageName('it')).toBe('Italian');
  expect(languageName('auto')).toBe('English');
});

it('ignores a profile model that is not a plain model id (it would become a command-line argument)', () => {
  const user = tmp();
  writeFileSync(join(user, 'bad-model.md'), '---\nname: bad-model\ndescription: d here\nmodel: x&calc\n---\nBODY');
  expect(loadProfile('bad-model', tmp(), user)!.model).toBeUndefined();
});
