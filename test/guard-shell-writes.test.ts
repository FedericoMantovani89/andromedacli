import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { fwd, OUTSIDE, verdict, WORKTREE, type Row } from './guard-table';
import { writeTargets } from '../src/server/guard/writes';

const OUT = fwd(OUTSIDE);
const TMP = fwd(tmpdir());
const WT = fwd(WORKTREE);
const OUTSIDE_RULE = 'path.outside-worktree';

describe('writeTargets', () => {
  it('finds redirects, destinations and named paths, and skips values', () => {
    expect(writeTargets(['echo', 'x', '>', 'a.txt'])).toEqual(['a.txt']);
    expect(writeTargets(['cp', 'src.txt', 'dst/'])).toEqual(['dst/']);
    expect(writeTargets(['mv', 'a', 'b'])).toEqual(['a', 'b']);
    expect(writeTargets(['Set-Content', 'f.txt', '/some/text'])).toEqual(['f.txt']);
    expect(writeTargets(['Set-Content', '-Value', 'x', '-Path', 'f.txt'])).toEqual(['f.txt']);
    expect(writeTargets(['robocopy', 'src', 'dst', '/MIR'])).toEqual(['dst']);
    expect(writeTargets(['cat', 'a.txt'])).toEqual([]);
  });
});

describe('bash: writes outside the worktree', () => {
  const rows: Row[] = [
    [`echo x > "${OUT}/x.bat"`, OUTSIDE_RULE],
    [`echo x >> ${OUT}/.gitconfig`, OUTSIDE_RULE],
    ['echo x > ../other.txt', OUTSIDE_RULE],
    ['cp f.txt ../other/', OUTSIDE_RULE],
    [`cp f.txt ${OUT}/`, OUTSIDE_RULE],
    [`mv ${OUT}/a b`, OUTSIDE_RULE],
    [`tee ${OUT}/x`, OUTSIDE_RULE],
    [`rm ${OUT}/x`, OUTSIDE_RULE],
    ['mkdir ../x', OUTSIDE_RULE],
    ['cd .. && echo x > a.txt', OUTSIDE_RULE],
    ['cd $(echo /c/Users) && echo x > a.txt', OUTSIDE_RULE],
    ['cd $(echo /c/Users) && rm -rf x', 'rm.wide'],
    // The tracked cwd moves with `cd` (Review Focus 3).
    ['cd src && echo x > a.txt', 'ALLOW'],
    ['cd src && cd .. && echo x > a.txt', 'ALLOW'],
    // Nothing that writes inside, to a null device or to the temp folder is touched (Review Focus 1 and 2).
    ['echo x > out.txt', 'ALLOW'],
    ['echo x > /dev/null', 'ALLOW'],
    ['echo x > nul', 'ALLOW'],
    [`echo x > ${TMP}/note.txt`, 'ALLOW'],
    [`cp f.txt ${WT}/sub/`, 'ALLOW'],
    ['cp ../shared/a.txt .', 'ALLOW'],
    ['npm test 2>&1 | tee test.log', 'ALLOW'],
    // Windows cmd switches (`/s`, `/q`) are not paths.
    ['rd /s /q dist', 'ALLOW'],
    ['del /q /f out.txt', 'ALLOW'],
    ['xcopy src build /E /I', 'ALLOW'],
    [`xcopy src ${OUT} /E /I`, OUTSIDE_RULE],
  ];
  it.each(rows)('%s -> %s', (c, e) => expect(verdict(c)).toBe(e));
});

describe('powershell: writes outside the worktree', () => {
  const rows: Row[] = [
    [`Set-Content ${OUTSIDE}\\x.txt hello`, OUTSIDE_RULE],
    [`Out-File -FilePath ${OUTSIDE}\\x.txt`, OUTSIDE_RULE],
    [`Set-Content -Value x -Path ${OUTSIDE}\\x.txt`, OUTSIDE_RULE],
    [`New-Item -ItemType File ${OUTSIDE}\\n.txt`, OUTSIDE_RULE],
    [`Copy-Item a.txt ${OUTSIDE}\\`, OUTSIDE_RULE],
    [`robocopy src ${OUTSIDE} /MIR`, OUTSIDE_RULE],
    ['Push-Location C:\\Users; Set-Content a.txt hi', OUTSIDE_RULE],
    // A value that looks like a path is a value (Review Focus 1).
    ['Set-Content out.txt "/some/text"', 'ALLOW'],
    ['Set-Content -Path out.txt -Value "C:\\Windows\\x"', 'ALLOW'],
    ['Push-Location src; Set-Content a.txt hi', 'ALLOW'],
    ['Get-Content src\\a.ts', 'ALLOW'],
  ];
  it.each(rows)('%s -> %s', (c, e) => expect(verdict(c, { tool: 'PowerShell' })).toBe(e));
});

it('the main is not bound by this rule (it works in the repository, and the rule is for agents)', () => {
  expect(verdict(`echo x > ${OUT}/x.txt`, { role: 'main' })).toBe('ALLOW');
});
