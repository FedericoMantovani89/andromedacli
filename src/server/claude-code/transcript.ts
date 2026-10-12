import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isObj } from '../../shared/guards';

export interface UsageEvent { kind: 'usage'; messageId: string; model?: string; ts?: string; input: number; output: number; cacheCreation: number; cacheRead: number }
export interface ToolUseEvent { kind: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
export interface ToolResultEvent { kind: 'tool_result'; toolUseId: string; isError: boolean; text: string }
export interface CompactEvent { kind: 'compact' }
export type TranscriptEvent = UsageEvent | ToolUseEvent | ToolResultEvent | CompactEvent;
export type ReadResult = { ok: true; events: TranscriptEvent[] } | { ok: false; code: 'missing' | 'unreadable' };

const MAX_RESULT_TEXT = 2000;

/** Claude Code names a project folder after the working directory with every non-alphanumeric character as a dash. */
export const encodeProjectDir = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');
export const transcriptPath = (projectsDir: string, cwd: string, sessionId: string): string => join(projectsDir, encodeProjectDir(cwd), `${sessionId}.jsonl`);
/**
 * The transcript of a session, given the folders it may be filed under in order of preference (the agent's worktree, then the folder
 * the session reported): the first whose file exists, else the first candidate. Undefined when there is no folder at all.
 */
export function pickTranscript(projectsDir: string, folders: (string | undefined)[], sessionId: string, exists: (file: string) => boolean = existsSync): string | undefined {
  const files = [...new Set(folders.filter((f): f is string => typeof f === 'string' && f !== '').map((f) => transcriptPath(projectsDir, f, sessionId)))];
  return files.find((f) => exists(f)) ?? files[0];
}
export const defaultProjectsDir =(): string => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

function textOf(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, MAX_RESULT_TEXT);
  if (Array.isArray(content)) return content.map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : '')).join('\n').slice(0, MAX_RESULT_TEXT);
  return '';
}

/**
 * Turns the Claude Code transcript (a JSONL file) into usage, tool and compaction events. Deterministic: no model reads it.
 * It remembers a byte offset per file and the message ids already counted: the same id appears on one line per content block.
 */
export const MAX_SEEN = 5000;
/** Remembers a counted message id; past the limit the oldest ones are forgotten (an id repeats only within a short stretch of the file). */
export function remember(seen: Set<string>, id: string): void {
  seen.add(id);
  while (seen.size > MAX_SEEN) {
    const oldest = seen.values().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}

export class TranscriptReader {
  private readonly state = new Map<string, { offset: number; seen: Set<string> }>();

  forget(file: string): void { this.state.delete(file); }

  /**
   * A session resumed with `--resume` appends to the transcript it already has, and a reader that has never seen the file (the
   * console just started) would count the whole old content again. Priming marks everything now in the file as counted; a file the
   * reader already follows is left alone.
   */
  prime(file: string): void {
    if (this.state.has(file) || !existsSync(file)) return;
    try { this.state.set(file, { offset: statSync(file).size, seen: new Set() }); } catch { /* unreadable: the first read decides */ }
  }

  read(file: string): ReadResult {
    if (!existsSync(file)) { this.state.delete(file); return { ok: false, code: 'missing' }; }
    let fd: number | undefined;
    try {
      const size = statSync(file).size;
      let st = this.state.get(file);
      if (!st || size < st.offset) { st = { offset: 0, seen: new Set() }; this.state.set(file, st); } // a smaller file is a new transcript
      if (size === st.offset) return { ok: true, events: [] };
      fd = openSync(file, 'r');
      const buf = Buffer.alloc(size - st.offset);
      const bytesRead = readSync(fd, buf, 0, buf.length, st.offset);
      const lastNewline = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (lastNewline < 0) return { ok: true, events: [] }; // the only line is still being written
      st.offset += lastNewline + 1;
      const lines = buf.subarray(0, lastNewline).toString('utf8').split('\n');
      const events: TranscriptEvent[] = [];
      const usageIndex = new Map<string, number>();
      for (const line of lines) {
        if (line.trim() === '') continue;
        let row: unknown;
        try { row = JSON.parse(line); } catch { continue; }
        if (!isObj(row)) continue;
        this.collect(row, events, usageIndex, st.seen);
      }
      for (const e of events) if (e.kind === 'usage') remember(st.seen, e.messageId);
      return { ok: true, events };
    } catch (err) {
      const code = err instanceof Error && 'code' in err && err.code === 'ENOENT' ? 'missing' : 'unreadable';
      if (code === 'missing') this.state.delete(file);
      return { ok: false, code };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private collect(row: Record<string, unknown>, events: TranscriptEvent[], usageIndex: Map<string, number>, seen: Set<string>): void {
    const message = isObj(row.message) ? row.message : undefined;
    if (row.type === 'assistant' && message) {
      const id = typeof message.id === 'string' ? message.id : undefined;
      const usage = isObj(message.usage) ? message.usage : undefined;
      if (id && usage && !seen.has(id)) {
        const e: UsageEvent = {
          kind: 'usage', messageId: id, model: typeof message.model === 'string' ? message.model : undefined, ts: typeof row.timestamp === 'string' ? row.timestamp : undefined,
          input: count(usage.input_tokens), output: count(usage.output_tokens), cacheCreation: count(usage.cache_creation_input_tokens), cacheRead: count(usage.cache_read_input_tokens),
        };
        const at = usageIndex.get(id);
        if (at === undefined) { usageIndex.set(id, events.length); events.push(e); } else events[at] = e; // the last line of an id wins
      }
      if (Array.isArray(message.content)) {
        for (const c of message.content) {
          if (isObj(c) && c.type === 'tool_use' && typeof c.id === 'string' && typeof c.name === 'string') {
            events.push({ kind: 'tool_use', id: c.id, name: c.name, input: isObj(c.input) ? c.input : {} });
          }
        }
      }
      return;
    }
    if (row.type === 'user') {
      if (row.isCompactSummary === true) { events.push({ kind: 'compact' }); return; }
      if (message && Array.isArray(message.content)) {
        for (const c of message.content) {
          if (isObj(c) && c.type === 'tool_result' && typeof c.tool_use_id === 'string') {
            events.push({ kind: 'tool_result', toolUseId: c.tool_use_id, isError: c.is_error === true, text: textOf(c.content) });
          }
        }
      }
    }
  }
}
