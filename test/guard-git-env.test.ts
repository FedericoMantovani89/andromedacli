import { describe, expect, it } from 'vitest';
import { GIT_BUILTINS } from '../src/server/guard/gitrefs';
import { verdict, type Row } from './guard-table';

const BASH_ENV = 'GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push GIT_CONFIG_KEY_1=core.hooksPath GIT_CONFIG_VALUE_1=nul git p origin HEAD:main';
const PS_ENV = '$env:GIT_CONFIG_COUNT=2; $env:GIT_CONFIG_KEY_0="alias.p"; $env:GIT_CONFIG_VALUE_0="push"; $env:GIT_CONFIG_KEY_1="core.hooksPath"; $env:GIT_CONFIG_VALUE_1="nul"; git p origin HEAD:main';

describe('git environment that changes config, hooks or programs', () => {
  const bash: Row[] = [
    [BASH_ENV, 'git.config-write'],
    ['GIT_DIR=../other/.git git status', 'git.config-write'],
    ['env GIT_SSH_COMMAND=evil git fetch', 'git.config-write'],
    ['export GIT_CONFIG_COUNT=1; git status', 'git.config-write'],
    ['git p origin HEAD:main', 'git.alias'],
    ['git wipe-everything', 'git.alias'],
    // Harmless variables and external commands stay allowed (Review Focus 4).
    ['GIT_TERMINAL_PROMPT=0 git fetch', 'ALLOW'],
    ['GIT_PAGER=cat git log', 'ALLOW'],
    ['git lfs pull', 'ALLOW'],
    ['git grep TODO', 'ALLOW'],
    ['git merge-tree HEAD HEAD', 'ALLOW'],
    ['git', 'ALLOW'],
  ];
  it.each(bash)('bash: %s -> %s', (c, e) => expect(verdict(c)).toBe(e));

  const ps: Row[] = [
    [PS_ENV, 'git.config-write'],
    ['Set-Item env:GIT_CONFIG_COUNT 1', 'git.config-write'],
    ['$env:GIT_PAGER="cat"; git log', 'ALLOW'],
  ];
  it.each(ps)('powershell: %s -> %s', (c, e) => expect(verdict(c, { tool: 'PowerShell' })).toBe(e));

  it('the main is denied with the hooks rule (it is a main rule)', () => {
    expect(verdict(BASH_ENV, { role: 'main' })).toBe('git.hooks-tamper');
    expect(verdict('GIT_PAGER=cat git log', { role: 'main' })).toBe('ALLOW');
  });

  it('GIT_BUILTINS holds every subcommand the rules name', () => {
    for (const sub of ['push', 'send-pack', 'http-push', 'commit', 'tag', 'branch', 'update-ref', 'symbolic-ref', 'worktree', 'switch', 'checkout', 'merge', 'rebase', 'pull', 'cherry-pick', 'am', 'reset', 'remote', 'config', 'status', 'diff', 'log', 'show', 'add', 'stash', 'fetch', 'rev-parse', 'lfs']) {
      expect(GIT_BUILTINS.has(sub), sub).toBe(true);
    }
  });
});
