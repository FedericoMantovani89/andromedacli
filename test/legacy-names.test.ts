import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateConfigFolder, migrateProjectFolder } from '../src/server/legacy-names';

const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'legacy-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8' });

describe('names of the earlier product', () => {
  it('moves the project folder, rewrites the stored paths and repairs a worktree', () => {
    const repo = tmp();
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first');
    const old = join(repo, '.andromedacli');
    mkdirSync(join(old, 'state'), { recursive: true });
    mkdirSync(join(old, 'worktrees'), { recursive: true });
    const wt = join(old, 'worktrees', 'job');
    git(repo, 'worktree', 'add', '-q', '-b', 'agent/x/job', wt);
    writeFileSync(join(old, 'state', 'agents.json'), JSON.stringify([{ worktree: wt }]));

    migrateProjectFolder(repo);

    const neu = join(repo, '.andromedaconsole');
    expect(existsSync(old)).toBe(false);
    expect(readFileSync(join(neu, 'state', 'agents.json'), 'utf8')).toContain('.andromedaconsole');
    expect(readFileSync(join(neu, 'state', 'agents.json'), 'utf8')).not.toContain('.andromedacli');
    expect(git(join(neu, 'worktrees', 'job'), 'status', '--short').trim()).toBe(''); // git still finds the worktree
    expect(git(repo, 'worktree', 'list')).toContain('.andromedaconsole');
  });

  it('leaves everything alone when the new folder exists already or the old one is missing', () => {
    const root = tmp();
    migrateProjectFolder(root);
    expect(existsSync(join(root, '.andromedaconsole'))).toBe(false);
    mkdirSync(join(root, '.andromedacli'));
    mkdirSync(join(root, '.andromedaconsole'));
    migrateProjectFolder(root);
    expect(existsSync(join(root, '.andromedacli'))).toBe(true);
  });

  it('moves the settings folder once', () => {
    const appData = tmp();
    mkdirSync(join(appData, 'andromedacli'));
    writeFileSync(join(appData, 'andromedacli', 'config.json'), '{}');
    migrateConfigFolder(appData);
    expect(existsSync(join(appData, 'andromedaconsole', 'config.json'))).toBe(true);
    expect(existsSync(join(appData, 'andromedacli'))).toBe(false);
  });
});
