// Type-checks the console mod (mod/hooks/register.js, JSDoc types) against the declarations Claude Code writes beside it
// (mod/.claude-plugin/types, git-ignored: the engine rewrites them each time it loads the mod). Without them there is nothing to
// check against, so the step says so and passes; it never fails for a missing file.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
if (!existsSync(resolve(root, 'mod/.claude-plugin/types/tsconfig.json'))) {
  console.log('check-mod: skipped (Claude Code has not written mod/.claude-plugin/types here yet; load the mod once to get them)');
  process.exit(0);
}
const r = spawnSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', resolve(root, 'mod/tsconfig.json'), '--noEmit'], { stdio: 'inherit' });
process.exit(r.status ?? 1);
