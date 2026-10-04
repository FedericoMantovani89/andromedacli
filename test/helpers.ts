// Shared test helpers: a real server with a fake agent, plain-http requests (so the Host header can be set), polling.
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { startServer } from '../src/server/index';
import type { Runner } from '../src/server/prereq/checks';

export type Running = Awaited<ReturnType<typeof startServer>>;

const fixture = join(__dirname, 'fixtures', 'fake-agent.cjs').replace(/\\/g, '/');
const running: Running[] = [];

export const goodRunner: Runner = async (cmd) => ({
  code: 0, stdout: cmd === 'node' ? 'v24.15.0' : cmd === 'git' ? 'git version 2.53.0' : '2.1.289 (Claude Code)',
});

/** Call once at the top of a test file: closes every server started with bootServer after each test. */
export function autoClose(): void {
  afterEach(async () => { while (running.length) await running.pop()!.close(); });
}

export async function bootServer(o: { planName?: string; language?: string } = {}): Promise<Running> {
  const configDir = mkdtempSync(join(tmpdir(), 'h-cfg-'));
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ schema: 1, language: o.language ?? 'en' }));
  const s = await startServer({
    port: 0, planRoot: mkdtempSync(join(tmpdir(), 'h-plan-')), configDir, planName: o.planName ?? 'shop-api',
    claudeCommand: [process.execPath, fixture], prereqRunner: goodRunner, modDir: null,
  });
  running.push(s);
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
