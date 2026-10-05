// Shared test helpers: a real server with a fake agent, plain-http requests (so the Host header can be set), polling.
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { startServer } from '../src/server/index';
import type { Runner } from '../src/server/prereq/checks';
import type { SleepClock } from '../src/server/budget/sleep';

/** A sleep clock that records its timers and moves only when told; `advance` fires what is due. */
export function fakeSleepClock(start = Date.parse('2026-10-05T10:00:00Z')) {
  let t = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void; ms: number }>();
  const clock: SleepClock = {
    now: () => t,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: t + ms, fn, ms }); return id; },
    clearTimeout: (h) => { timers.delete(h as number); },
  };
  const advance = (ms: number): void => {
    const target = t + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, x]) => x.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      t = Math.max(t, due[1].at);
      due[1].fn();
    }
    t = target;
  };
  return { clock, advance, timers, now: () => t };
}

export type Running = Awaited<ReturnType<typeof startServer>>;

const fixture = join(__dirname, 'fixtures', 'fake-agent.cjs').replace(/\\/g, '/');
const running: Running[] = [];
const configFiles = new WeakMap<Running, string>();

/** The config.json a server booted with bootServer reads and writes. */
export const configFileOf = (s: Running): string => configFiles.get(s)!;

export const goodRunner: Runner = async (cmd) => ({
  code: 0, stdout: cmd === 'node' ? 'v24.15.0' : cmd === 'git' ? 'git version 2.53.0' : '2.1.289 (Claude Code)',
});

/** Call once at the top of a test file: closes every server started with bootServer after each test. */
export function autoClose(): void {
  afterEach(async () => { while (running.length) await running.pop()!.close(); });
}

/**
 * A real server with the fake agent. Agents share the plan folder (`git.worktrees: false`, the Phase 2 behaviour) unless the
 * test passes a repository as `planRoot` and `config: { git: { worktrees: true } }`.
 */
export async function bootServer(o: { planName?: string; language?: string; planRoot?: string; config?: Record<string, unknown>; afterWorktreeCreated?: (slug: string) => void | Promise<void>; launchCheckMs?: number; projectsDir?: string; tickMs?: number; sleepClock?: SleepClock } = {}): Promise<Running> {
  const configDir = mkdtempSync(join(tmpdir(), 'h-cfg-'));
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ schema: 1, language: o.language ?? 'en', git: { worktrees: false }, ...o.config }));
  const s = await startServer({
    port: 0, planRoot: o.planRoot ?? mkdtempSync(join(tmpdir(), 'h-plan-')), configDir, planName: o.planName ?? 'shop-api',
    claudeCommand: [process.execPath, fixture], prereqRunner: goodRunner, modDir: null, afterWorktreeCreated: o.afterWorktreeCreated, launchCheckMs: o.launchCheckMs,
    // Transcripts: a folder of the test's own (or one nobody writes to), never the user's ~/.claude/projects.
    projectsDir: o.projectsDir ?? mkdtempSync(join(tmpdir(), 'h-proj-')), tickMs: o.tickMs, sleepClock: o.sleepClock,
  });
  running.push(s);
  configFiles.set(s, join(configDir, 'config.json'));
  return s;
}

export interface Res { status: number; body: any }

export function req(s: Running, path: string, o: { method?: string; token?: string; host?: string; body?: unknown } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: o.host ?? `127.0.0.1:${s.port}` };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    const payload = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    if (payload !== undefined) headers['content-type'] = 'application/json';
    const r = http.request({ host: '127.0.0.1', port: s.port, path, method: o.method ?? 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { let body: any = data; try { body = JSON.parse(data); } catch { /* not json */ } resolve({ status: res.statusCode ?? 0, body }); });
    });
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

export const ui = (s: Running, path: string, method = 'GET', body?: unknown): Promise<Res> => req(s, path, { method, token: s.token, body });
export const mod = (s: Running, slug: string, path: string, method = 'GET', body?: unknown): Promise<Res> =>
  req(s, path, { method, token: s.sessionTokenFor(slug), body });
export const state = async (s: Running) => (await ui(s, '/api/state')).body;

export async function until(f: () => Promise<boolean> | boolean, ms = 8000): Promise<void> {
  const t = Date.now();
  while (!(await f())) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 30));
  }
}

/** The events a mod would send, so tests can drive agent states without a real Claude. */
export const modEvent = (s: Running, slug: string, type: string, data?: unknown): Promise<Res> =>
  mod(s, slug, '/v1/events', 'POST', { type, sessionId: `sess-${slug}`, data });
