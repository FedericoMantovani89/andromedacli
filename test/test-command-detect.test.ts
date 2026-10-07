import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { autoClose, bootServer, state, ui } from './helpers';

autoClose();

const projectWith = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'detect-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
};

describe('the test command the project suggests', () => {
  it('is reported from package.json and pom.xml, and from nothing when the folder has neither', async () => {
    const web = await bootServer({ projectRoot: projectWith({ 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }) }) });
    expect((await state(web)).project.detectedTestCommand).toBe('npm test');
    const java = await bootServer({ projectRoot: projectWith({ 'pom.xml': '<project/>' }) });
    expect((await state(java)).project.detectedTestCommand).toMatch(/mvn test$/);
    const none = await bootServer({ projectRoot: projectWith({}) });
    expect((await state(none)).project.detectedTestCommand).toBeUndefined();
  });
  it('stays reported next to a command the user saved, which wins', async () => {
    const s = await bootServer({ projectRoot: projectWith({ 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }) }) });
    expect((await ui(s, '/api/project', 'PUT', { testCommand: 'my test' })).status).toBe(200);
    const p = (await state(s)).project;
    expect(p).toMatchObject({ testCommand: 'my test', detectedTestCommand: 'npm test' });
  });
});
