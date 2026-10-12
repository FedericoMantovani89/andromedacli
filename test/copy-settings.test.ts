import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ProjectStore } from '../src/server/project-store';
import { copyProjectSettings } from '../src/server/templates/copy';

const folder = (): string => mkdtempSync(join(tmpdir(), 'copy-settings-'));

it('copies profiles, rules and the project fields; the name and the agents stay', () => {
  const a = folder();
  const b = folder();
  const from = new ProjectStore(a);
  from.init('alpha');
  from.setTestCommand('npm test');
  from.setSquash(false);
  from.setFields({ model: 'opus', agentTokens: 250_000, maxActive: 2, docs: ['README.md'] });
  from.addAgent({ slug: 'one', profile: 'developer' });
  mkdirSync(join(a, '.andromedaconsole', 'profiles'), { recursive: true });
  writeFileSync(join(a, '.andromedaconsole', 'profiles', 'custom.md'), 'profile');
  writeFileSync(join(a, '.andromedaconsole', 'rules.md'), 'rules');

  expect(copyProjectSettings(a, b, 'beta')).toEqual({ ok: true });
  const to = new ProjectStore(b);
  expect(to.project).toMatchObject({ name: 'beta', testCommand: 'npm test', squash: false, model: 'opus', agentTokens: 250_000, maxActive: 2, docs: ['README.md'] });
  expect(to.listAgents()).toEqual([]);
  expect(readFileSync(join(b, '.andromedaconsole', 'profiles', 'custom.md'), 'utf8')).toBe('profile');
  expect(readFileSync(join(b, '.andromedaconsole', 'rules.md'), 'utf8')).toBe('rules');
  expect(existsSync(join(b, '.andromedaconsole', 'main.md'))).toBe(false);
});

it('a field the source lacks is cleared in the target, so the two end up alike', () => {
  const a = folder();
  const b = folder();
  new ProjectStore(a).init('alpha');
  const to = new ProjectStore(b);
  to.init('beta');
  to.setFields({ model: 'sonnet', maxActive: 5 });
  to.setTestCommand('make');
  expect(copyProjectSettings(a, b, 'beta')).toEqual({ ok: true });
  expect(to.project.model).toBeUndefined();
  expect(to.project.maxActive).toBeUndefined();
  expect(to.project.testCommand).toBeUndefined();
});

it('a source that is not a project is refused', () => {
  const r = copyProjectSettings(folder(), folder(), 'beta');
  expect(r.ok).toBe(false);
});

it('the "tests switched off" choice is copied too, and a source that runs its tests turns it off', () => {
  const a = folder();
  const b = folder();
  const from = new ProjectStore(a);
  from.init('alpha');
  from.setTestsDisabled(true);
  expect(copyProjectSettings(a, b, 'beta')).toEqual({ ok: true });
  expect(new ProjectStore(b).project.testsDisabled).toBe(true);
  from.setTestsDisabled(false);
  expect(copyProjectSettings(a, b, 'beta')).toEqual({ ok: true });
  expect(new ProjectStore(b).project.testsDisabled).toBeUndefined();
});
