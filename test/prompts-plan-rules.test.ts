import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadProfile, renderAgentPrompt, renderMainPrompt } from '../src/server/profiles';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'prm-'));
function planWith(files: Record<string, string>): string {
  const root = tmp();
  mkdirSync(join(root, '.console'), { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(root, '.console', f), text);
  return root;
}
const main = (planRoot?: string): string => readFileSync(renderMainPrompt({ plan: 'shop-api', workLanguage: 'English', outDir: tmp(), planRoot }), 'utf8');
const agent = (o: { planRoot?: string; docs?: string[]; review?: boolean }): string =>
  readFileSync(renderAgentPrompt({ profile: loadProfile('backend', tmp(), tmp())!, slug: 'fix-login', plan: 'shop-api', outDir: tmp(), ...o }), 'utf8');

it('without planRoot the prompts are unchanged', () => {
  expect(main()).toBe(main(tmp()));
  expect(agent({})).not.toMatch(/At the last step update/);
});

it('the main gets the plan main.md and rules.md, after its own text', () => {
  const text = main(planWith({ 'main.md': 'MAIN GUIDE', 'rules.md': 'PLAN RULES' }));
  expect(text).toContain('MAIN GUIDE');
  expect(text).toContain('PLAN RULES');
  expect(text.indexOf('MAIN GUIDE')).toBeLessThan(text.indexOf('PLAN RULES'));
  expect(text.indexOf('You are the main session')).toBeLessThan(text.indexOf('MAIN GUIDE'));
});

it('an agent gets rules.md but not main.md', () => {
  const text = agent({ planRoot: planWith({ 'main.md': 'MAIN GUIDE', 'rules.md': 'PLAN RULES' }) });
  expect(text).toContain('PLAN RULES');
  expect(text).not.toContain('MAIN GUIDE');
});

it('the documents to update are named for an author only', () => {
  const root = planWith({});
  expect(agent({ planRoot: root, docs: ['README.md', 'CHANGELOG.md'] })).toContain('At the last step update: README.md, CHANGELOG.md.');
  expect(agent({ planRoot: root, docs: ['README.md'], review: true })).not.toContain('At the last step update');
  expect(agent({ planRoot: root, docs: [] })).not.toContain('At the last step update');
});

it('missing or empty files add nothing', () => {
  expect(agent({ planRoot: planWith({ 'rules.md': '  \n' }) })).toBe(agent({}));
});
