import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { transcriptPath } from '../src/server/claude-code/transcript';
import { bootServer, until } from './helpers';

const SID = '7487d159-b5c4-4f4f-8624-992be7e584c7';
function projectWithSavedMain(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mr-project-'))); // long form: the console launches Claude in the canonical folder, and its transcripts are named after that
  mkdirSync(join(root, '.andromedaconsole', 'state'), { recursive: true });
  writeFileSync(join(root, '.andromedaconsole', 'state', 'main.json'), JSON.stringify({ sessionId: SID }));
  return root;
}

it('a saved main session with no transcript starts a new session instead of failing with "No conversation found"', async () => {
  const projectRoot = projectWithSavedMain();
  const s = await bootServer({ projectRoot });
  await until(() => s.lastLaunchArgs('shop-api') !== undefined);
  expect(s.lastLaunchArgs('shop-api')).not.toContain('--resume');
});

it('a saved main session that has a transcript is resumed', async () => {
  const projectRoot = projectWithSavedMain();
  const projectsDir = mkdtempSync(join(tmpdir(), 'mr-proj-'));
  const file = transcriptPath(projectsDir, projectRoot, SID);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '');
  const s = await bootServer({ projectRoot, projectsDir });
  await until(() => s.lastLaunchArgs('shop-api') !== undefined);
  const args = s.lastLaunchArgs('shop-api')!;
  expect(args[args.indexOf('--resume') + 1]).toBe(SID);
});
