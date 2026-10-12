import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { StateProblems } from '../src/server/state-problems';

const root = join('D:', 'work', 'shop');
const now = (): Date => new Date('2026-10-12T10:00:00Z');

it('keeps what was set aside, with paths relative to the project folder', () => {
  const changed = vi.fn();
  const p = new StateProblems(root, changed, now);
  p.add(join(root, '.andromedaconsole', 'state', 'agents.json'), join(root, '.andromedaconsole', 'state', 'agents.json.corrupt-20261012T100000Z'));
  expect(p.list()).toEqual([{ file: '.andromedaconsole/state/agents.json', movedTo: '.andromedaconsole/state/agents.json.corrupt-20261012T100000Z', at: '2026-10-12T10:00:00.000Z' }]);
  expect(changed).toHaveBeenCalledTimes(1);
});

it('keeps the newest 20 and clear() empties the list and says so', () => {
  const changed = vi.fn();
  const p = new StateProblems(root, changed, now);
  for (let i = 0; i < 25; i++) p.add(join(root, `f${i}.json`), join(root, `f${i}.json.corrupt-x`));
  expect(p.list().length).toBe(20);
  expect(p.list()[19]?.file).toBe('f24.json');
  changed.mockClear();
  p.clear();
  expect(p.list()).toEqual([]);
  expect(changed).toHaveBeenCalledTimes(1);
});
