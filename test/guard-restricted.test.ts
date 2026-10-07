import { describe, expect, it } from 'vitest';
import { callSignature, evaluate, type GuardContext } from '../src/server/guard/rules';

const base: GuardContext = { worktree: 'C:/w/a', repo: 'C:/w/repo', branch: 'agent/p/a', projectBranch: 'project/p', secretPatterns: [] };

describe('restricted sessions', () => {
  it('refuses every guarded tool under a budget restriction, reads included', () => {
    const ctx = { ...base, restricted: { reason: 'budget' as const } };
    for (const [tool, input] of [['Bash', { command: 'ls' }], ['Read', { file_path: 'C:/w/a/x.ts' }], ['Edit', { file_path: 'C:/w/a/x.ts' }], ['Grep', { path: 'C:/w/a' }], ['WebFetch', {}], ['WebSearch', {}], ['Agent', {}]] as const) {
      expect(evaluate({ role: 'agent', tool, input: { ...input } }, ctx)).toMatchObject({ decision: 'deny', rule: 'budget.limit' });
    }
  });

  it('the refusal under a budget or limit restriction names only step_done (writing a note is refused too)', () => {
    for (const reason of ['budget', 'limit'] as const) {
      const d = evaluate({ role: 'agent', tool: 'Write', input: { file_path: 'C:/w/a/.console/handover.md' } }, { ...base, restricted: { reason } });
      expect(d).toMatchObject({ decision: 'deny' });
      const text = (d as { reason: string }).reason;
      expect(text).toContain('step_done');
      expect(text).not.toMatch(/handover/);
    }
  });

  it('refuses every guarded tool under a subscription limit', () => {
    const ctx = { ...base, restricted: { reason: 'limit' as const } };
    expect(evaluate({ role: 'agent', tool: 'Read', input: { file_path: 'C:/w/a/x.ts' } }, ctx)).toMatchObject({ decision: 'deny', rule: 'quota.limit' });
  });

  it('refuses only the repeated call under a loop restriction', () => {
    const sig = callSignature('Bash', { command: 'npm test' });
    const ctx = { ...base, restricted: { reason: 'loop' as const, signature: sig } };
    expect(evaluate({ role: 'agent', tool: 'Bash', input: { command: 'npm test' } }, ctx)).toMatchObject({ decision: 'deny', rule: 'loop.repeat' });
    expect(evaluate({ role: 'agent', tool: 'Bash', input: { command: 'ls' } }, ctx)).toEqual({ decision: 'allow' });
    expect(evaluate({ role: 'agent', tool: 'Read', input: { file_path: 'C:/w/a/x.ts' } }, ctx)).toEqual({ decision: 'allow' });
  });

  it('never restricts the main', () => {
    expect(evaluate({ role: 'main', tool: 'Bash', input: { command: 'ls' } }, { ...base, restricted: { reason: 'budget' } })).toEqual({ decision: 'allow' });
  });

  it('has a stable signature that ignores key order and unrelated fields', () => {
    expect(callSignature('Bash', { command: 'x' })).toBe(callSignature('Bash', { command: 'x' }));
    expect(callSignature('Bash', { command: 'x', other: 1 })).toBe(callSignature('Bash', { command: 'x' }));
    expect(callSignature('Read', { path: 'p', file_path: 'f' })).toBe(callSignature('Read', { file_path: 'f', path: 'p' }));
    expect(callSignature('Bash', { command: 'x' })).not.toBe(callSignature('PowerShell', { command: 'x' }));
    expect(callSignature('Bash', { command: 'x' })).not.toBe(callSignature('Bash', { command: 'y' }));
  });
});
