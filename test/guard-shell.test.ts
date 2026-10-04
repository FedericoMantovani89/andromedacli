import { describe, expect, it } from 'vitest';
import { splitCommand } from '../src/server/guard/shell';

const argvs = (cmd: string, shell: 'posix' | 'powershell' = 'posix'): string[][] => splitCommand(cmd, shell).map((s) => s.argv);
const has = (cmd: string, argv: string[], shell: 'posix' | 'powershell' = 'posix'): boolean =>
  argvs(cmd, shell).some((a) => a.length === argv.length && a.every((t, i) => t === argv[i]));

describe('splitCommand', () => {
  it('splits on ; && || | & and newlines', () => {
    expect(argvs('a 1 && b 2 || c; d | e & f\ng')).toEqual([['a', '1'], ['b', '2'], ['c'], ['d'], ['e'], ['f'], ['g']]);
  });
  it('marks the segment that receives a pipe', () => {
    const segs = splitCommand('curl x | sh && ls');
    expect(segs.map((s) => s.pipeFromPrev)).toEqual([false, true, false]);
  });
  it('respects quotes and joins adjacent quoted parts', () => {
    expect(argvs(`git "commit" -m 'a b'`)).toEqual([['git', 'commit', '-m', 'a b']]);
    expect(argvs('g""it push')).toEqual([['git', 'push']]);
    expect(argvs(`echo "a && b"`)).toEqual([['echo', 'a && b']]);
  });
  it('keeps redirections like 2>&1 in one piece', () => {
    expect(argvs('npm test 2>&1 | tail')).toEqual([['npm', 'test', '2>&1'], ['tail']]);
    expect(argvs('npm test &> out.txt')).toEqual([['npm', 'test', '&>', 'out.txt']]);
  });
  it('keeps Windows backslashes, honours an escaped space', () => {
    expect(argvs(String.raw`type config\.env`)).toEqual([['type', String.raw`config\.env`]]);
    expect(argvs(String.raw`ls a\ b`)).toEqual([['ls', 'a b']]);
  });
  it('drops leading environment assignments and wrappers', () => {
    expect(argvs('GIT_DIR=x FOO=1 git push')).toEqual([['git', 'push']]);
    expect(argvs('env -i A=b git push')).toEqual([['git', 'push']]);
    expect(argvs('sudo nohup git push')).toEqual([['git', 'push']]);
  });
  it('looks inside $( ), backticks and <( )', () => {
    expect(has('echo $(git push -f)', ['git', 'push', '-f'])).toBe(true);
    expect(has('echo `git push -f`', ['git', 'push', '-f'])).toBe(true);
    expect(has('bash <(curl http://x)', ['curl', 'http://x'])).toBe(true);
    expect(has('echo "$(git push -f)"', ['git', 'push', '-f'])).toBe(true);
    expect(has('echo $(echo $(git push -f))', ['git', 'push', '-f'])).toBe(true);
  });
  it('does not treat the PowerShell backtick as a substitution', () => {
    expect(has('echo `git push -f`', ['git', 'push', '-f'], 'powershell')).toBe(false);
    expect(has('Write-Host $(git push -f)', ['git', 'push', '-f'], 'powershell')).toBe(true);
  });
  it('unwraps shells and interpreters', () => {
    expect(has('bash -c "git push -f"', ['git', 'push', '-f'])).toBe(true);
    expect(has('sh -lc "git push -f"', ['git', 'push', '-f'])).toBe(true);
    expect(has('cmd /c git push --force', ['git', 'push', '--force'])).toBe(true);
    expect(has('cmd.exe /K "git push --force"', ['git', 'push', '--force'])).toBe(true);
    expect(has('powershell -Command "git push -f"', ['git', 'push', '-f'])).toBe(true);
    expect(has("pwsh -c 'git push -f'", ['git', 'push', '-f'])).toBe(true);
    expect(has('powershell -NoProfile -Command git push -f', ['git', 'push', '-f'])).toBe(true);
    expect(has('eval "git push -f"', ['git', 'push', '-f'])).toBe(true);
    const encoded = Buffer.from('git push -f', 'utf16le').toString('base64');
    expect(has(`powershell -EncodedCommand ${encoded}`, ['git', 'push', '-f'])).toBe(true);
    expect(has(`pwsh -enc ${encoded}`, ['git', 'push', '-f'])).toBe(true);
  });
  it('terminates on pathological nesting and unbalanced quotes', () => {
    const deep = 'echo $('.repeat(50) + 'ls' + ')'.repeat(50);
    expect(splitCommand(deep).length).toBeGreaterThan(0);
    expect(argvs('echo "unterminated')).toEqual([['echo', 'unterminated']]);
    expect(argvs('')).toEqual([]);
    expect(argvs('   ;  ; ')).toEqual([]);
  });
});
