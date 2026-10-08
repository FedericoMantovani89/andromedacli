// pre-commit rule: a commit that changes the product (src, catalog, templates, prompts, mod) carries a line in CHANGELOG.md.
// `SKIP_CHANGELOG=1 git commit ...` skips it (a wip commit, a pure refactor with no visible change).
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const PRODUCT = /^(src|catalog|templates|prompts|mod)\//;

export const missingChangelog = (staged: readonly string[]): boolean => staged.some((f) => PRODUCT.test(f)) && !staged.includes('CHANGELOG.md');

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.SKIP_CHANGELOG === '1') process.exit(0);
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' }).split('\n').map((l) => l.trim()).filter(Boolean);
  if (missingChangelog(staged)) {
    console.error('pre-commit: this commit changes the product but not CHANGELOG.md. Add a line under [Unreleased] (or set SKIP_CHANGELOG=1 for a commit with no visible change).');
    process.exit(1);
  }
}
