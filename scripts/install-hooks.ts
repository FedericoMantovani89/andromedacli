// `npm run hooks`: puts .githooks/pre-commit into this repository's git hooks folder. Only that hook: the console's own pre-push hook in the
// same folder is not touched (core.hooksPath is deliberately not used, it would stop the pre-push hook from running).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
const hooks = join(common, 'hooks');
mkdirSync(hooks, { recursive: true });
const text = readFileSync(resolve('.githooks', 'pre-commit'), 'utf8').replace(/\r\n/g, '\n'); // a hook must have LF line endings
writeFileSync(join(hooks, 'pre-commit'), text, { mode: 0o755 });
console.log(`pre-commit installed in ${hooks}`);
