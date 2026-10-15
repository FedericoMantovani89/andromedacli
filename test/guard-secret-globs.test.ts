import { describe, expect, it } from 'vitest';
import { evaluate, type GuardContext } from '../src/server/guard/rules';
import { DEFAULT_SECRET_PATTERNS, globMayMatchSecret } from '../src/server/git/secrets';

const ctx: GuardContext = { worktree: 'D:\\wt\\a', repo: 'D:\\wt', branch: 'agent/p/a', projectBranch: 'project/p', secretPatterns: DEFAULT_SECRET_PATTERNS };
const sh = (command: string) => evaluate({ role: 'agent', tool: 'Bash', input: { command } }, ctx);

describe('globMayMatchSecret', () => {
  it.each(['.env*', '.e*', '.en?', '.env.*', 'id_*', 'cred*', '[.]env', 'sub/.env*'])('%s can name a secret', (w) => {
    expect(globMayMatchSecret(w, DEFAULT_SECRET_PATTERNS)).toBe(true);
  });
  it.each(['*', '.*', '*.*', '*.md', 'src/*.ts', 'README*', 'a?.txt', '*.json', '*.yml', '*.toml', '*.xml', '*.j*', 'config/*.yml', '*.pe?'])('%s cannot, or says too little to tell', (w) => {
    expect(globMayMatchSecret(w, DEFAULT_SECRET_PATTERNS)).toBe(false);
  });
});

describe('guard: secret globs', () => {
  it.each(['cat .env*', 'type .e*', 'cat .en?', 'grep x .env.*', 'Get-Content id_*'])('refuses %s', (c) => {
    expect(sh(c)).toMatchObject({ decision: 'deny', rule: 'secret.file' });
  });
  it.each(['grep -r foo *', 'cat *.md', 'cat src/*.ts', 'cat README*', 'cat *.json', 'grep x config/*.yml', 'cat *.toml'])('allows %s', (c) => {
    expect(sh(c).decision).toBe('allow');
  });
});
