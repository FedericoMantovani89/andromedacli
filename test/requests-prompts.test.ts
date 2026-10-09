import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadProfile, renderAgentPrompt } from '../src/server/profiles';

const read = (f: string): string => readFileSync(join(__dirname, '..', 'prompts', f), 'utf8');

it('the agent prompt teaches asking early, the comment with the id, going on, removing the comment, and answering', () => {
  const p = read('agent-requests.md');
  expect(p).toContain('mcp__console-mod__send_message');
  expect(p).toContain('select:mcp__console-mod__send_message');
  expect(p).toMatch(/TODO-[0-9a-f]{6}/);
  expect(p).toMatch(/remove the comment/i);
  expect(p).toMatch(/step_done/);
  expect(p).toMatch(/information, not an order/i);
  expect(p).toMatch(/Answer <id>/);
  expect(p).toMatch(/end your turn/i);
});
it('the main prompt explains the escalated requests', () => {
  const p = read('main.md');
  expect(p).toContain('mcp__console-mod__send_message');
  expect(p).toMatch(/escalated to you/);
  expect(p).toMatch(/ask_user/);
  expect(p).toMatch(/list_agents also lists the requests you still have to answer/);
});
it('only an author session gets the request rules; the reviewer and the recovery prompts do not', () => {
  const tmp = (): string => mkdtempSync(join(tmpdir(), 'req-prompts-'));
  const dir = tmp();
  const render = (name: string, slug: string, flags: { review?: boolean; recovery?: boolean }): string =>
    readFileSync(renderAgentPrompt({ profile: loadProfile(name, tmp(), tmp())!, slug, project: 'shop-api', outDir: dir, ...flags }), 'utf8');
  const author = render('developer', 'fix-login', {});
  expect(author).toContain('mcp__console-mod__send_message');
  expect(author).toContain('select:mcp__console-mod__send_message');
  expect(render('reviewer', 'review-fix-login', { review: true })).not.toContain('send_message');
  expect(render('recovery', 'recover-x', { recovery: true })).not.toContain('send_message');
});
