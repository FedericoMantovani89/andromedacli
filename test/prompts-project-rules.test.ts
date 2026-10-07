import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadProfile, renderAgentPrompt, renderMainPrompt } from '../src/server/profiles';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'prm-'));
function projectWith(files: Record<string, string>): string {
  const root = tmp();
  mkdirSync(join(root, '.andromedacli'), { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(root, '.andromedacli', f), text);
  return root;
}
const main = (projectRoot?: string): string => readFileSync(renderMainPrompt({ project: 'shop-api', workLanguage: 'English', outDir: tmp(), projectRoot }), 'utf8');
const agent = (o: { projectRoot?: string; docs?: string[]; review?: boolean }): string =>
  readFileSync(renderAgentPrompt({ profile: loadProfile('developer', tmp(), tmp())!, slug: 'fix-login', project: 'shop-api', outDir: tmp(), ...o }), 'utf8');

it('without projectRoot the prompts are unchanged', () => {
  expect(main()).toBe(main(tmp()));
  expect(agent({})).not.toMatch(/At the last step update/);
});

it('the main gets the project main.md and rules.md, after its own text', () => {
  const text = main(projectWith({ 'main.md': 'MAIN GUIDE', 'rules.md': 'PROJECT RULES' }));
  expect(text).toContain('MAIN GUIDE');
  expect(text).toContain('PROJECT RULES');
  expect(text.indexOf('MAIN GUIDE')).toBeLessThan(text.indexOf('PROJECT RULES'));
  expect(text.indexOf('You are the main session')).toBeLessThan(text.indexOf('MAIN GUIDE'));
});

it('an agent gets rules.md but not main.md', () => {
  const text = agent({ projectRoot: projectWith({ 'main.md': 'MAIN GUIDE', 'rules.md': 'PROJECT RULES' }) });
  expect(text).toContain('PROJECT RULES');
  expect(text).not.toContain('MAIN GUIDE');
});

it('the documents to update are named for an author only', () => {
  const root = projectWith({});
  expect(agent({ projectRoot: root, docs: ['README.md', 'CHANGELOG.md'] })).toContain('At the last step update: README.md, CHANGELOG.md.');
  expect(agent({ projectRoot: root, docs: ['README.md'], review: true })).not.toContain('At the last step update');
  expect(agent({ projectRoot: root, docs: [] })).not.toContain('At the last step update');
});

it('missing or empty files add nothing', () => {
  expect(agent({ projectRoot: projectWith({ 'rules.md': '  \n' }) })).toBe(agent({}));
});
