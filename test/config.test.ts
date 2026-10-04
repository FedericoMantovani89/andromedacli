import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfigAtomic, DEFAULT_CONFIG } from '../src/server/config';

const dir = () => mkdtempSync(join(tmpdir(), 'cfg-'));
it('returns defaults when the file is missing', () => {
  expect(loadConfig(join(dir(), 'config.json'))).toEqual({ config: DEFAULT_CONFIG, errors: [] });
});
it('keeps valid values and falls back per invalid entry without throwing', () => {
  const p = join(dir(), 'config.json');
  writeFileSync(p, JSON.stringify({ schema: 1, language: 'it', agents: { bypassPermissions: 'yes' }, telemetry: true }));
  const { config, errors } = loadConfig(p);
  expect(config.language).toBe('it');
  expect(config.agents.bypassPermissions).toBe(false);
  expect(config.telemetry).toBe(false);
  expect(errors.map((e) => e.path).sort()).toEqual(['agents.bypassPermissions', 'telemetry']);
});
it('survives corrupt JSON', () => {
  const p = join(dir(), 'config.json');
  writeFileSync(p, '{not json');
  const r = loadConfig(p);
  expect(r.config).toEqual(DEFAULT_CONFIG);
  expect(r.errors[0]?.code).toBe('config.unreadable');
});
it('writes atomically (temp file then rename)', () => {
  const d = dir(), p = join(d, 'config.json');
  saveConfigAtomic(p, { ...DEFAULT_CONFIG, language: 'en' });
  expect(JSON.parse(readFileSync(p, 'utf8')).language).toBe('en');
  expect(existsSync(p + '.tmp')).toBe(false);
});

it('the mod is enabled by default and a non-boolean value falls back with an error', () => {
  expect(DEFAULT_CONFIG.mod.enabled).toBe(true);
  const p = join(dir(), 'config.json');
  writeFileSync(p, JSON.stringify({ mod: { enabled: 'no' } }));
  const { config, errors } = loadConfig(p);
  expect(config.mod.enabled).toBe(true);
  expect(errors.map((e) => e.path)).toEqual(['mod.enabled']);
});

it('git and guard defaults: worktrees on, 15 minute test timeout, guard enforcing, secret patterns present', () => {
  expect(DEFAULT_CONFIG.git.worktrees).toBe(true);
  expect(DEFAULT_CONFIG.git.testTimeoutMinutes).toBe(15);
  expect(DEFAULT_CONFIG.git.secretPatterns).toContain('.env');
  expect(DEFAULT_CONFIG.guard.mode).toBe('enforce');
  expect(DEFAULT_CONFIG.agents.bypassPermissions).toBe(false);
});
it('accepts valid git and guard entries', () => {
  const p = join(dir(), 'config.json');
  writeFileSync(p, JSON.stringify({ git: { worktrees: false, secretPatterns: ['*.token'], testTimeoutMinutes: 30 }, guard: { mode: 'shadow' } }));
  const { config, errors } = loadConfig(p);
  expect(errors).toEqual([]);
  expect(config.git).toEqual({ worktrees: false, secretPatterns: ['*.token'], testTimeoutMinutes: 30 });
  expect(config.guard.mode).toBe('shadow');
});
it('invalid git and guard entries fall back one by one and are reported', () => {
  const p = join(dir(), 'config.json');
  writeFileSync(p, JSON.stringify({ git: { worktrees: 'no', secretPatterns: [1], testTimeoutMinutes: 0 }, guard: { mode: 'off' } }));
  const { config, errors } = loadConfig(p);
  expect(config.git).toEqual(DEFAULT_CONFIG.git);
  expect(config.guard.mode).toBe('enforce');
  expect(errors.map((e) => e.path).sort()).toEqual(['git.secretPatterns', 'git.testTimeoutMinutes', 'git.worktrees', 'guard.mode']);
  writeFileSync(p, JSON.stringify({ git: 5, guard: 'x' }));
  expect(loadConfig(p).errors.map((e) => e.path).sort()).toEqual(['git', 'guard.mode']);
});
