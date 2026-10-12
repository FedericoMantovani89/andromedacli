// Contract check against the real `claude` (no quota: it only reads --version and --help and validates the mod).
// Run it for each new Claude Code version, before raising TESTED_CLAUDE_MAX in src/server/claude-code/compat.ts:
//   npx tsx test/e2e/claude-contract.ts
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { compareVersions, MINIMUM } from '../../src/server/prereq/checks';
import { CLAUDE_FLAGS, TESTED_CLAUDE_MAX } from '../../src/server/claude-code/compat';

const run = (args: string[]) => spawnSync('claude', args, { encoding: 'utf8', shell: process.platform === 'win32', timeout: 60_000 });
const problems: string[] = [];

const v = run(['--version']);
const version = /(\d+\.\d+\.\d+)/.exec(v.stdout ?? '')?.[1];
if (!version) problems.push('claude --version printed no version');
else {
  console.log(`claude ${version} (minimum ${MINIMUM.claude}, last tested ${TESTED_CLAUDE_MAX})`);
  if (compareVersions(version, MINIMUM.claude) < 0) problems.push(`version ${version} is below the minimum ${MINIMUM.claude}`);
}

const help = run(['--help']).stdout ?? '';
// Since 2.1.296 the help lists `--append-system-prompt <prompt>` and mentions the file form only as `--append-system-prompt[-file]`.
const HELP_FORM: Record<string, string> = { '--append-system-prompt-file': '--append-system-prompt[-file]' };
for (const flag of CLAUDE_FLAGS) if (!help.includes(flag) && !help.includes(HELP_FORM[flag] ?? flag)) problems.push(`claude --help no longer lists ${flag}`);

const val = run(['plugin', 'validate', resolve(import.meta.dirname, '../../mod')]);
if (val.status !== 0) problems.push(`claude plugin validate mod failed:\n${val.stdout}${val.stderr}`);

if (problems.length > 0) { console.error('CONTRACT BROKEN:\n- ' + problems.join('\n- ')); process.exit(1); }
console.log(`contract holds (${CLAUDE_FLAGS.length} flags, mod validates)`);
