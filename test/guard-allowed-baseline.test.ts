import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { fwd, verdict, WORKTREE, type Row } from './guard-table';

const TMP = fwd(tmpdir());
const WT = fwd(WORKTREE);

/** Everyday agent work. Every rule added to the guard must leave these allowed: they are the false-positive budget. */
const BASH: string[] = [
  'npm run build', 'npm test', 'npx vitest run test/a.test.ts', 'node scripts/check.js', 'CI=1 npm test',
  'git status', 'git status --short', 'git diff HEAD~1', 'git log --oneline -5', 'git add -A', 'git add src/a.ts', 'git stash list',
  'git rev-parse HEAD', 'git branch --show-current', 'git branch --list', 'git config --get user.name', 'git checkout -- src/a.ts',
  'git show HEAD:src/a.ts', 'git reset HEAD src/a.ts', 'git fetch', 'git lfs pull',
  'GIT_TERMINAL_PROMPT=0 git fetch', 'GIT_PAGER=cat git log',
  'ls -la', 'cat src/a.ts', 'cat .env.example', 'sed -n 1,5p src/a.ts', 'grep -rn TODO src',
  'mkdir -p build/out', 'echo hi > out.txt', 'echo hi >> out.txt', 'echo x > /dev/null', 'npm test 2>&1 | tee test.log',
  'cp a.txt b.txt', 'cp -r src build', 'mv a.txt b.txt', 'rm build/out.txt', 'rm -rf node_modules', 'touch x',
  `echo x > ${TMP}/note.txt`, `echo x > ${WT}/sub/note.txt`, 'cd src && echo x > a.txt', 'cp ../shared/a.txt .',
];
const POWERSHELL: string[] = [
  'Get-ChildItem -Recurse src', 'Get-Content src\\a.ts', 'Set-Content out.txt hello', 'Set-Content out.txt "/some/text"',
  'Set-Content -Path out.txt -Value "C:\\Windows\\x"', 'Out-File -FilePath out.txt', 'Remove-Item -Recurse -Force build',
  'New-Item -ItemType Directory build', 'Copy-Item a.txt b.txt', 'npm run build; npm test',
];

describe('commands that must stay allowed', () => {
  it.each(BASH.map((c): Row => [c, 'ALLOW']))('bash: %s', (c, e) => expect(verdict(c)).toBe(e));
  it.each(POWERSHELL.map((c): Row => [c, 'ALLOW']))('powershell: %s', (c, e) => expect(verdict(c, { tool: 'PowerShell' })).toBe(e));
});
