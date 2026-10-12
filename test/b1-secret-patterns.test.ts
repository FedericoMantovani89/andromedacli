import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(new URL(`../src/server/${rel}`, import.meta.url), 'utf8');

// B1: worktree_cleanup passed only the global secret patterns, so the project's own patterns did not apply to the WIP commit it makes
// before a push. The composition now lives in src/server/runtime/: every place that needs the patterns reads the combined ones
// (the global plus the project's) through the `secretPatterns` service, never `runtime.git.secretPatterns` alone.
it('every call that saves work before a push or judges a path uses the project\'s secret patterns, not only the global ones (B1)', () => {
  for (const file of ['index.ts', 'runtime/guard-call.ts', 'runtime/tools/agents.ts', 'runtime/helpers.ts', 'runtime/state.ts']) {
    expect(read(file), file).not.toMatch(/secretPatterns:\s*runtime\.git\.secretPatterns/);
  }
  expect(read('runtime/tools/agents.ts')).toMatch(/secretPatterns:\s*secretPatterns\(\)/); // worktree_cleanup
  expect(read('runtime/guard-call.ts')).toMatch(/secretPatterns:\s*secretPatterns\(\)/); // the guard
  expect(read('runtime/helpers.ts')).toMatch(/secretPatterns:\s*c\.get\('secretPatterns'\)\(\)/); // the WIP commit of budget, loop, quota
});
