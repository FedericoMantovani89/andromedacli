import { it, expect } from 'vitest';
import { parseCliArgs, planNameFromDir } from '../src/server/cli-args';

it('defaults to serve on port 7391 in the current folder', () => {
  const a = parseCliArgs([], 'D:/work/shop-api');
  expect(a).toMatchObject({ command: 'serve', port: 7391, planRoot: 'D:/work/shop-api', noOpen: false, json: false });
});
it('reads flags', () => {
  const a = parseCliArgs(['serve', '--port', '8000', '--plan-root', 'E:/x', '--no-open'], 'D:/work');
  expect(a).toMatchObject({ command: 'serve', port: 8000, planRoot: 'E:/x', noOpen: true });
});
it('reads doctor --json', () => {
  expect(parseCliArgs(['doctor', '--json'], 'D:/work')).toMatchObject({ command: 'doctor', json: true });
});
it('rejects an invalid port and unknown commands', () => {
  expect(() => parseCliArgs(['serve', '--port', 'abc'], '.')).toThrow(/port/);
  expect(() => parseCliArgs(['launch'], '.')).toThrow(/command/);
});
it('derives a valid plan name from a folder name', () => {
  expect(planNameFromDir('D:/work/Shop API_v2')).toBe('shop-api-v2');
  expect(planNameFromDir('D:/work/ab')).toBe('plan-ab');
  expect(planNameFromDir('D:/work/___')).toBe('plan');
  expect(planNameFromDir('D:/work/Attività Casa')).toBe('attivita-casa');
});
