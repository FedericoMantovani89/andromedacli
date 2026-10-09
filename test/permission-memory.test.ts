import { it, expect } from 'vitest';
import { PermissionMemory } from '../src/server/questions/permission-memory';

it('remembers the exact tool and detail for one agent only', () => {
  const m = new PermissionMemory();
  m.remember('a', 'Bash', 'rm -rf build', 'deny');
  expect(m.recall('a', 'Bash', 'rm -rf build')).toBe('deny');
  expect(m.recall('a', 'Bash', 'rm -rf build2')).toBeUndefined();
  expect(m.recall('a', 'Write', 'rm -rf build')).toBeUndefined();
  expect(m.recall('b', 'Bash', 'rm -rf build')).toBeUndefined();
});
it('never remembers an empty detail (the key would match everything of that tool)', () => {
  const m = new PermissionMemory();
  m.remember('a', 'Bash', '', 'allow');
  expect(m.recall('a', 'Bash', '')).toBeUndefined();
});
it('forget drops everything of one agent', () => {
  const m = new PermissionMemory();
  m.remember('a', 'Bash', 'ls', 'allow');
  m.forget('a');
  expect(m.recall('a', 'Bash', 'ls')).toBeUndefined();
});
