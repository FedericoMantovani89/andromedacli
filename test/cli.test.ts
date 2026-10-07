import { it, expect } from 'vitest';
import { parseCliArgs, projectNameFromDir } from '../src/server/cli-args';

it('defaults to serve on port 7391 in the current folder', () => {
  const a = parseCliArgs([], 'D:/work/shop-api');
  expect(a).toMatchObject({ command: 'serve', port: 7391, projectRoot: 'D:/work/shop-api', noOpen: false, json: false });
});
it('reads flags', () => {
  const a = parseCliArgs(['serve', '--port', '8000', '--project-root', 'E:/x', '--no-open'], 'D:/work');
  expect(a).toMatchObject({ command: 'serve', port: 8000, projectRoot: 'E:/x', noOpen: true });
});
it('knows whether the project folder was given: without --project-root the console opens the remembered projects, or none', () => {
  expect(parseCliArgs([], 'D:/work/shop-api').projectRootGiven).toBe(false);
  expect(parseCliArgs(['serve', '--port', '8000'], 'D:/work').projectRootGiven).toBe(false);
  expect(parseCliArgs(['serve', '--project-root', 'E:/x'], 'D:/work').projectRootGiven).toBe(true);
});
it('reads doctor --json', () => {
  expect(parseCliArgs(['doctor', '--json'], 'D:/work')).toMatchObject({ command: 'doctor', json: true });
});
it('rejects an invalid port and unknown commands', () => {
  expect(() => parseCliArgs(['serve', '--port', 'abc'], '.')).toThrow(/port/);
  expect(() => parseCliArgs(['launch'], '.')).toThrow(/command/);
});
it('derives a valid project name from a folder name', () => {
  expect(projectNameFromDir('D:/work/Shop API_v2')).toBe('shop-api-v2');
  expect(projectNameFromDir('D:/work/ab')).toBe('project-ab');
  expect(projectNameFromDir('D:/work/___')).toBe('project');
  expect(projectNameFromDir('D:/work/Attività Casa')).toBe('attivita-casa');
});
