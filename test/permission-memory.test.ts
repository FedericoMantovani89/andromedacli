import { it, expect } from 'vitest';
import { PermissionMemory } from '../src/server/questions/permission-memory';

it('remembers the exact tool and key for one agent only', () => {
  const m = new PermissionMemory();
  m.remember('a', 'Bash', 'rm -rf build', 'deny');
  expect(m.recall('a', 'Bash', 'rm -rf build')).toBe('deny');
  expect(m.recall('a', 'Bash', 'rm -rf build2')).toBeUndefined();
  expect(m.recall('a', 'Write', 'rm -rf build')).toBeUndefined();
  expect(m.recall('b', 'Bash', 'rm -rf build')).toBeUndefined();
});
it('never remembers an empty or blank key (it would match everything of that tool)', () => {
  const m = new PermissionMemory();
  m.remember('a', 'Bash', '', 'allow');
  m.remember('a', 'Bash', '   ', 'allow');
  expect(m.recall('a', 'Bash', '')).toBeUndefined();
  expect(m.recall('a', 'Bash', '   ')).toBeUndefined();
});
it('forget drops everything of one agent, also its waiting items', () => {
  const m = new PermissionMemory();
  m.remember('a', 'Bash', 'ls', 'allow');
  m.track('q1', 'a', 'Bash', 'ls');
  m.track('q2', 'b', 'Bash', 'ls');
  m.forget('a');
  expect(m.recall('a', 'Bash', 'ls')).toBeUndefined();
  expect(m.siblings('b', 'Bash', 'ls', 'none')).toEqual(['q2']);
  expect(m.siblings('a', 'Bash', 'ls', 'none')).toEqual([]);
});
it('siblings are the other waiting items of the same agent, tool and key', () => {
  const m = new PermissionMemory();
  m.track('q1', 'a', 'Bash', 'ls');
  m.track('q2', 'a', 'Bash', 'ls');
  m.track('q3', 'a', 'Bash', 'pwd');
  m.track('q4', 'b', 'Bash', 'ls');
  expect(m.siblings('a', 'Bash', 'ls', 'q1')).toEqual(['q2']);
  m.untrack('q2');
  expect(m.siblings('a', 'Bash', 'ls', 'q1')).toEqual([]);
});
