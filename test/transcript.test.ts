import { appendFileSync, copyFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeProjectDir, pickTranscript, TranscriptReader, transcriptPath } from '../src/server/budget/transcript';

const sample = join(__dirname, 'fixtures', 'transcript-sample.jsonl');
const tmp = () => mkdtempSync(join(tmpdir(), 'h-tr-'));

describe('encodeProjectDir', () => {
  it('replaces every non-alphanumeric character with a dash, like Claude Code does', () => {
    expect(encodeProjectDir('D:\\workspaces\\multiconsole')).toBe('D--workspaces-multiconsole');
    expect(encodeProjectDir('D:\\workspaces\\multiconsole.worktrees\\fix-x')).toBe('D--workspaces-multiconsole-worktrees-fix-x');
    expect(transcriptPath('/p', 'C:\\a b', 's1')).toMatch(/C--a-b[\\/]s1\.jsonl$/);
  });
});

describe('TranscriptReader', () => {
  it('counts a message id once and reports tool events and compactions', () => {
    const r = new TranscriptReader();
    const out = r.read(sample);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const usage = out.events.filter((e) => e.kind === 'usage');
    expect(usage.map((u) => [u.messageId, u.input, u.cacheCreation, u.cacheRead, u.output])).toEqual([['msg_A', 10, 100, 1000, 5], ['msg_B', 20, 0, 2000, 30]]);
    expect(out.events.find((e) => e.kind === 'tool_use')).toMatchObject({ id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } });
    expect(out.events.find((e) => e.kind === 'tool_result')).toMatchObject({ toolUseId: 'toolu_1', isError: false, text: 'ok' });
    expect(out.events.filter((e) => e.kind === 'compact')).toHaveLength(1);
  });

  it('reads only what is new and never emits an id twice', () => {
    const f = join(tmp(), 't.jsonl');
    copyFileSync(sample, f);
    const r = new TranscriptReader();
    r.read(f);
    const again = r.read(f);
    expect(again).toEqual({ ok: true, events: [] });
    appendFileSync(f, '{"type":"assistant","message":{"id":"msg_A","usage":{"input_tokens":99,"output_tokens":99},"content":[]}}\n');
    expect(r.read(f)).toEqual({ ok: true, events: [] }); // msg_A was already counted
    appendFileSync(f, '{"type":"assistant","message":{"id":"msg_C","usage":{"input_tokens":1,"output_tokens":2},"content":[]}}\n');
    const c = r.read(f);
    expect(c.ok && c.events.filter((e) => e.kind === 'usage')).toHaveLength(1);
  });

  it('waits for a half written last line and skips a corrupt one', () => {
    const f = join(tmp(), 't.jsonl');
    writeFileSync(f, 'not json\n{"type":"assistant","message":{"id":"msg_P","usage":{"input_tokens":1,"output_tokens":1},"content":[]}}');
    const r = new TranscriptReader();
    expect(r.read(f)).toEqual({ ok: true, events: [] });
    appendFileSync(f, '\n');
    const out = r.read(f);
    expect(out.ok && out.events).toHaveLength(1);
  });

  it('starts over when the file got smaller, and says so when it is missing', () => {
    const f = join(tmp(), 't.jsonl');
    copyFileSync(sample, f);
    const r = new TranscriptReader();
    r.read(f);
    truncateSync(f, 0);
    writeFileSync(f, '{"type":"assistant","message":{"id":"msg_Z","usage":{"input_tokens":3,"output_tokens":4},"content":[]}}\n');
    const out = r.read(f);
    expect(out.ok && out.events.filter((e) => e.kind === 'usage')).toHaveLength(1);
    expect(r.read(join(tmp(), 'none.jsonl'))).toEqual({ ok: false, code: 'missing' });
    // after shrink, msg_A is emitted again (seen was reset)
    appendFileSync(f, '{"type":"assistant","message":{"id":"msg_A","usage":{"input_tokens":10,"output_tokens":5},"content":[]}}\n');
    const reEmit = r.read(f);
    expect(reEmit.ok && reEmit.events.filter((e) => e.kind === 'usage').map((u) => u.messageId)).toContain('msg_A');
  });

  it('keeps the last line of an id inside one batch', () => {
    const f = join(tmp(), 't.jsonl');
    writeFileSync(f,
      '{"type":"assistant","message":{"id":"msg_Q","usage":{"input_tokens":1,"output_tokens":5},"content":[]}}\n' +
      '{"type":"assistant","message":{"id":"msg_Q","usage":{"input_tokens":1,"output_tokens":50},"content":[]}}\n');
    const out = new TranscriptReader().read(f);
    expect(out.ok && out.events.filter((e) => e.kind === 'usage').map((u) => (u as { output: number }).output)).toEqual([50]);
  });

  it('resets state when file is deleted and recreated larger, returning events from start', () => {
    const f = join(tmp(), 't.jsonl');
    copyFileSync(sample, f);
    const r = new TranscriptReader();
    const first = r.read(f);
    expect(first.ok && first.events.filter((e) => e.kind === 'usage')).toHaveLength(2); // msg_A, msg_B
    rmSync(f);
    const missing = r.read(f);
    expect(missing).toEqual({ ok: false, code: 'missing' });
    // recreate file LARGER than old offset (1137 bytes) with 30+ lines and a reused id (msg_A)
    let content = '';
    for (let i = 0; i < 30; i++) {
      content += `{"type":"assistant","message":{"id":"msg_${i}","usage":{"input_tokens":${i},"output_tokens":${i + 1}},"content":[]}}\n`;
    }
    // include msg_A (a reused id from before the deletion)
    content += '{"type":"assistant","message":{"id":"msg_A","usage":{"input_tokens":100,"output_tokens":200},"content":[]}}\n';
    writeFileSync(f, content);
    const after = r.read(f);
    expect(after.ok && after.events.filter((e) => e.kind === 'usage')).toHaveLength(31); // 30 new ids + msg_A
    const ids = after.ok ? after.events.filter((e) => e.kind === 'usage').map((u) => u.messageId) : [];
    expect(ids).toContain('msg_A'); // msg_A should be emitted again after file deletion and recreation
  });
});

describe('pickTranscript', () => {
  it('prefers the worktree, then the reported cwd, returning the first candidate whose file exists, else the first', () => {
    const p = (cwd: string) => transcriptPath('/proj', cwd, 's1');
    const none = () => false;
    expect(pickTranscript('/proj', ['C:/w/a', 'C:/w/b'], 's1', none)).toBe(p('C:/w/a'));
    expect(pickTranscript('/proj', ['C:/w/a', 'C:/w/b'], 's1', (f) => f === p('C:/w/b'))).toBe(p('C:/w/b'));
    expect(pickTranscript('/proj', ['C:/w/a', 'C:/w/b'], 's1', () => true)).toBe(p('C:/w/a'));
    expect(pickTranscript('/proj', [undefined, 'C:/w/b'], 's1', none)).toBe(p('C:/w/b'));
    expect(pickTranscript('/proj', [undefined, undefined], 's1', none)).toBeUndefined();
  });
});

describe('TranscriptReader.prime (a session resumed with --resume)', () => {
  const usageLine = (id: string): string => `{"type":"assistant","message":{"id":"${id}","usage":{"input_tokens":5,"output_tokens":5},"content":[]}}\n`;

  it('skips what the transcript already holds and counts only what the resumed session adds', () => {
    const f = join(tmp(), 't.jsonl');
    copyFileSync(sample, f); // the first run, already in the ledger
    const r = new TranscriptReader(); // a console that has just started: it knows nothing of the file
    r.prime(f);
    expect(r.read(f)).toEqual({ ok: true, events: [] });
    appendFileSync(f, usageLine('msg_NEW'));
    const after = r.read(f);
    expect(after.ok && after.events.filter((e) => e.kind === 'usage').map((e) => (e as { messageId: string }).messageId)).toEqual(['msg_NEW']);
  });
  it('without it the whole old content would be counted again (what prime prevents)', () => {
    const f = join(tmp(), 't.jsonl');
    copyFileSync(sample, f);
    const read = new TranscriptReader().read(f);
    expect(read.ok && read.events.some((e) => e.kind === 'usage')).toBe(true);
  });
  it('leaves a file the reader already follows alone, and does nothing for a missing file', () => {
    const f = join(tmp(), 't.jsonl');
    writeFileSync(f, usageLine('msg_ONE'));
    const r = new TranscriptReader();
    r.read(f);
    appendFileSync(f, usageLine('msg_TWO')); // not read yet
    r.prime(f);
    const next = r.read(f);
    expect(next.ok && next.events.filter((e) => e.kind === 'usage')).toHaveLength(1); // msg_TWO is still counted
    expect(() => r.prime(join(tmp(), 'nope.jsonl'))).not.toThrow();
    expect(r.read(join(tmp(), 'nope.jsonl'))).toEqual({ ok: false, code: 'missing' });
  });
});
