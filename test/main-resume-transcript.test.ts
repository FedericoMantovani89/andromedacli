import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { transcriptPath } from '../src/server/budget/transcript';
import { bootServer, until } from './helpers';

const SID = '7487d159-b5c4-4f4f-8624-992be7e584c7';
function planWithSavedMain(): string {
  const root = mkdtempSync(join(tmpdir(), 'mr-plan-'));
  mkdirSync(join(root, '.console', 'state'), { recursive: true });
  writeFileSync(join(root, '.console', 'state', 'main.json'), JSON.stringify({ sessionId: SID }));
  return root;
}

it('a saved main session with no transcript starts a new session instead of failing with "No conversation found"', async () => {
  const planRoot = planWithSavedMain();
  const s = await bootServer({ planRoot });
  await until(() => s.lastLaunchArgs('shop-api') !== undefined);
  expect(s.lastLaunchArgs('shop-api')).not.toContain('--resume');
});

it('a saved main session that has a transcript is resumed', async () => {
  const planRoot = planWithSavedMain();
  const projectsDir = mkdtempSync(join(tmpdir(), 'mr-proj-'));
  const file = transcriptPath(projectsDir, planRoot, SID);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '');
  const s = await bootServer({ planRoot, projectsDir });
  await until(() => s.lastLaunchArgs('shop-api') !== undefined);
  const args = s.lastLaunchArgs('shop-api')!;
  expect(args[args.indexOf('--resume') + 1]).toBe(SID);
});
