import { describe, expect, it } from 'vitest';
import { isLongFlag } from '../src/server/guard/rules';
import { verdict, type Row } from './guard-table';

describe('isLongFlag', () => {
  it('accepts the flag and its unambiguous-looking prefixes of three letters or more', () => {
    expect(isLongFlag('--no-verify', 'no-verify')).toBe(true);
    expect(isLongFlag('--no-verif', 'no-verify')).toBe(true);
    expect(isLongFlag('--no-v', 'no-verify')).toBe(true);
    expect(isLongFlag('--har', 'hard')).toBe(true);
    expect(isLongFlag('--force-with-lease=main:abc', 'force-with-lease')).toBe(true);
  });
  it('rejects short prefixes, other flags and short flags', () => {
    expect(isLongFlag('--no', 'no-verify')).toBe(false);
    expect(isLongFlag('--d', 'delete')).toBe(false);
    expect(isLongFlag('--format', 'force')).toBe(false);
    expect(isLongFlag('-f', 'force')).toBe(false);
    expect(isLongFlag('no-verify', 'no-verify')).toBe(false);
  });
});

describe('abbreviated git flags', () => {
  const agent: Row[] = [
    ['git reset --har HEAD~1', 'git.merge-rebase-reset-hard'],
    ['git reset --mer HEAD~1', 'git.merge-rebase-reset-hard'],
    ['git checkout -bnew', 'git.checkout-switch'],
    ['git checkout --detac abc123', 'git.checkout-switch'],
    ['git branch --delet old', 'git.delete-ref'],
    ['git branch --forc topic HEAD~1', 'git.force'],
    // Must stay allowed (Review Focus 5).
    ['git branch --format=%(refname)', 'ALLOW'],
    ['git branch --show-current', 'ALLOW'],
    ['git reset --soft HEAD~1', 'ALLOW'],
    ['git reset HEAD src/a.ts', 'ALLOW'],
    ['git checkout -- src/a.ts', 'ALLOW'],
  ];
  it.each(agent)('agent: %s -> %s', (c, e) => expect(verdict(c)).toBe(e));

  const main: Row[] = [
    ['git push --no-verif origin agent/p/job', 'git.no-verify'],
    ['git push --forc origin HEAD:agent/x', 'git.force'],
    ['git push origin --delet agent/p/x', 'git.delete-ref'],
    ['git commit --no-verif -m x', 'git.no-verify'],
    ['git push --force origin main', 'git.force'],
  ];
  it.each(main)('main: %s -> %s', (c, e) => expect(verdict(c, { role: 'main' })).toBe(e));
});

describe('git config outside the repository', () => {
  it('the main cannot write global or system config, or an include', () => {
    expect(verdict('git config --global include.path D:/x/gitconfig', { role: 'main' })).toBe('git.hooks-tamper');
    expect(verdict('git config --system core.autocrlf true', { role: 'main' })).toBe('git.hooks-tamper');
    expect(verdict('git config include.path ../x', { role: 'main' })).toBe('git.hooks-tamper');
  });
  it('the main may read global config and write repository config', () => {
    expect(verdict('git config --global --get user.name', { role: 'main' })).toBe('ALLOW');
    expect(verdict('git config user.name x', { role: 'main' })).toBe('ALLOW');
  });
  it('an agent is denied any config write as before', () => {
    expect(verdict('git config --global include.path D:/x/gitconfig')).toBe('git.config-write');
    expect(verdict('git config user.name x')).toBe('git.config-write');
  });
});
