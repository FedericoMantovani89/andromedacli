import { describe, expect, it } from 'vitest';
import { evaluate, type GuardContext } from '../src/server/guard/rules';
import { writeTargets } from '../src/server/guard/writes';
import { DEFAULT_SECRET_PATTERNS } from '../src/server/git/secrets';

const ctx: GuardContext = { worktree: 'D:\\wt\\a', repo: 'D:\\wt', branch: 'agent/p/a', projectBranch: 'project/p', secretPatterns: DEFAULT_SECRET_PATTERNS };
const sh = (command: string, tool = 'Bash') => evaluate({ role: 'agent', tool, input: { command } }, ctx);
const OUT = 'C:\\Users\\Public';

describe('writeTargets', () => {
  it('names where a downloader saves', () => {
    expect(writeTargets(['curl', '-o', `${OUT}\\x.txt`, 'http://e.com'])).toContain(`${OUT}\\x.txt`);
    expect(writeTargets(['Invoke-WebRequest', 'http://e.com', '-OutFile', `${OUT}\\x.txt`])).toContain(`${OUT}\\x.txt`);
    expect(writeTargets(['wget', `--output=${OUT}\\x.txt`, 'http://e.com'])).toContain(`${OUT}\\x.txt`);
  });
  it('does not take the URL after curl -O for a target', () => {
    expect(writeTargets(['curl', '-O', 'https://e.com/a.txt'])).toEqual([]);
  });
  it('names the directory of cp -t and mv -t', () => {
    expect(writeTargets(['cp', '-t', OUT, 'f.txt'])).toContain(OUT);
    expect(writeTargets(['cp', `--target-directory=${OUT}`, 'f.txt'])).toContain(OUT);
    expect(writeTargets(['cp', '--target-directory', OUT, 'f.txt'])).toContain(OUT);
  });
  it('names the destination of git clone', () => {
    expect(writeTargets(['git', 'clone', 'http://e.com/r.git', `${OUT}\\r`])).toContain(`${OUT}\\r`);
    expect(writeTargets(['git', 'clone', '--depth', '1', '-b', 'dev', 'http://e.com/r.git', `${OUT}\\r`])).toContain(`${OUT}\\r`);
    expect(writeTargets(['git', '-C', OUT, 'clone', 'http://e.com/r.git'])).toContain(OUT);
    expect(writeTargets(['git', 'clone', 'http://e.com/r.git'])).toEqual([]);
  });
});

describe('guard: writes outside the worktree', () => {
  it.each([
    `curl -o ${OUT}\\x.txt http://e.com`,
    `curl --output ${OUT}\\x.txt http://e.com`,
    `cp -t ${OUT} f.txt`,
    `git clone http://e.com/r.git ${OUT}\\r`,
  ])('refuses %s', (c) => {
    expect(sh(c)).toMatchObject({ decision: 'deny', rule: 'path.outside-worktree' });
  });
  it.each([
    `curl -sLo ${OUT}\\x http://e.com`,
    `curl --output-dir ${OUT} -O http://e.com/a`,
    `wget -P ${OUT} http://e.com/a`,
    `wget --output-document=${OUT}\\x http://e.com`,
    `cp -t${OUT} f.txt`,
    `git clone --shallow-since 2020-01-01 http://e.com/r.git ${OUT}\\r`,
    `git clone --separate-git-dir=${OUT}\\g http://e.com/r.git sub`,
  ])('refuses the other spellings: %s', (c) => {
    expect(sh(c)).toMatchObject({ decision: 'deny', rule: 'path.outside-worktree' });
  });
  it('refuses the abbreviated PowerShell parameter -OutF', () => {
    expect(sh(`iwr http://e.com -OutF ${OUT}\\x`, 'PowerShell')).toMatchObject({ decision: 'deny', rule: 'path.outside-worktree' });
  });
  it.each([
    `ls -t ${OUT}`,
    'docker build -t img .',
    'bitsadmin /list',
    `git -C ${OUT} log --grep clone`,
  ])('does not take %s for a write', (c) => {
    expect(sh(c).decision).toBe('allow');
  });
  it('refuses Invoke-WebRequest -OutFile outside', () => {
    expect(sh(`Invoke-WebRequest http://e.com -OutFile ${OUT}\\x.txt`, 'PowerShell')).toMatchObject({ decision: 'deny', rule: 'path.outside-worktree' });
  });
  it.each([
    'curl -o out.txt http://e.com',
    'curl -O https://e.com/a.txt',
    'cp -t sub f.txt',
    'git clone http://e.com/r.git sub',
    'git clone http://e.com/r.git',
  ])('still allows %s', (c) => {
    expect(sh(c).decision).toBe('allow');
  });
});
