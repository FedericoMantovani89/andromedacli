import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HelperUsage } from '../src/server/helper-usage';
import { commandWords, helpersUsedIn, helperToolsText } from '../src/server/helper-tools';
import type { PrereqResult } from '../src/shared/protocol';

const ok = (id: PrereqResult['id']): PrereqResult => ({ id, required: false, status: 'ok', version: '1.0' });

describe('commandWords / helpersUsedIn', () => {
  it('takes the first word of every command, through pipes, lists, subshells and prefixes', () => {
    expect(commandWords('rg -n foo src | jq -r .name && fd -e ts')).toEqual(['rg', 'jq', 'fd']);
    expect(commandWords('FOO=1 sudo C:\\tools\\rg.exe -l x; time python3 build.py')).toEqual(['rg', 'python3']);
    expect(commandWords('echo $(fd -t f) `jq .`')).toEqual(['echo', 'fd', 'jq']);
    expect(commandWords('git log\nuv pip install x')).toEqual(['git', 'uv']);
  });
  it('a helper counts once per line, whatever the number of stages, and a word inside an argument is not a use', () => {
    expect(helpersUsedIn('jq .a x.json | jq .b')).toEqual(['jq']);
    expect(helpersUsedIn('grep -r "rg" . ; echo jq')).toEqual([]);
    expect(helpersUsedIn('python3 a.py | shellcheck -')).toEqual(['python', 'shellcheck']);
    expect(helpersUsedIn('py -3 -m venv .v')).toEqual(['python']);
  });
});

describe('helperToolsText', () => {
  it('lists only the helpers whose check is ok, with what they are for and what to prefer them to', () => {
    const text = helperToolsText([ok('rg'), ok('jq'), { id: 'fd', required: false, status: 'missing' }, { id: 'node', required: true, status: 'ok' }])!;
    expect(text).toContain('`rg` (searches file contents quickly)');
    expect(text).toContain('`jq` (reads and edits JSON)');
    expect(text).not.toContain('`fd`');
    expect(text).not.toContain('node');
    expect(text).toContain('`rg` over `grep`');
    expect(text).toContain('do not assume any other tool exists');
  });
  it('says nothing when no helper is installed or the checks have not finished (unknown is never ok)', () => {
    expect(helperToolsText(null)).toBeUndefined();
    expect(helperToolsText([{ id: 'rg', required: false, status: 'error' }, { id: 'jq', required: false, status: 'restart' }])).toBeUndefined();
  });
});

describe('HelperUsage', () => {
  const file = (): string => join(mkdtempSync(join(tmpdir(), 'helper-usage-')), 'state', 'helper-usage.json');
  it('counts helpers (only counters are kept), writes them, and starts again from the file', () => {
    const f = file();
    const usage = new HelperUsage(f, () => new Date('2026-10-08T10:00:00Z'));
    usage.record('rg -n foo | jq .');
    usage.record('rg bar');
    usage.record('git status'); // not a helper
    usage.flush();
    expect(usage.state()).toEqual({ since: '2026-10-08T10:00:00.000Z', counts: { rg: 2, jq: 1 } });
    const text = readFileSync(f, 'utf8');
    expect(text).not.toContain('foo');
    expect(text).not.toContain('git');
    const again = new HelperUsage(f);
    expect(again.state().counts).toEqual({ rg: 2, jq: 1 });
    expect(again.state().since).toBe('2026-10-08T10:00:00.000Z');
  });
  it('a damaged file starts a new count', () => {
    const f = file();
    const usage = new HelperUsage(f);
    usage.record('fd x');
    usage.flush();
    writeFileSync(f, '{nope');
    expect(new HelperUsage(f).state().counts).toEqual({});
  });
});
