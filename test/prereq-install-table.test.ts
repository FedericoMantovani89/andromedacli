import { it, expect } from 'vitest';
import { INSTALL_TABLE } from '../src/server/prereq/install';

it('every entry is a fixed argv whose display is exactly that argv joined', () => {
  expect(INSTALL_TABLE.length).toBeGreaterThan(0);
  for (const e of INSTALL_TABLE) {
    expect(Array.isArray(e.argv)).toBe(true);
    expect(e.argv.length).toBeGreaterThan(0);
    expect(e.argv.every((a) => typeof a === 'string' && a !== '')).toBe(true);
    expect(e.display).toBe(e.argv.join(' '));
    expect(e.source.origin).not.toBe('');
  }
});

it('covers node, git, claude and gh, each with an install and an update', () => {
  for (const id of ['node', 'git', 'claude', 'gh']) {
    expect(INSTALL_TABLE.filter((e) => e.id === id).map((e) => e.action).sort()).toEqual(['install', 'update']);
  }
});

it('scripts demand a second confirmation and nothing else does; none ships yet', () => {
  for (const e of INSTALL_TABLE) expect(e.secondConfirm).toBe(e.source.kind === 'script');
  expect(INSTALL_TABLE.some((e) => e.source.kind === 'script')).toBe(false);
});

it('uses the scoped npm package for Claude Code and winget with an exact id for the rest', () => {
  expect(INSTALL_TABLE.find((e) => e.id === 'claude' && e.action === 'install')!.argv).toEqual(['npm', 'install', '-g', '@anthropic-ai/claude-code']);
  expect(INSTALL_TABLE.find((e) => e.id === 'claude' && e.action === 'update')!.argv.at(-1)).toBe('@anthropic-ai/claude-code@latest');
  for (const e of INSTALL_TABLE.filter((x) => x.source.kind === 'winget')) {
    expect(e.argv[0]).toBe('winget');
    expect(e.argv).toContain('-e');
    expect(e.argv).toContain('--id');
  }
});

it('is unverified on this machine (V23 was not run), and the table is frozen data, not built from input', () => {
  expect(INSTALL_TABLE.every((e) => e.verified === false)).toBe(true);
  // No entry has a placeholder or a shell metacharacter that something could be spliced into.
  for (const e of INSTALL_TABLE) expect(e.display).not.toMatch(/[{}$`|&;<>]/);
});
