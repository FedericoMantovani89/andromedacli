import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildClaudeLaunch } from './pty/claude-launch';
import { PtyManager } from './pty/pty-manager';
import { PlanStore } from './plan-store';
import { bundlePayload, type Bundles } from './i18n-bundles';
import { extractToken, isAllowedHost, tokensEqual } from './security';
import { validateSlug } from '../shared/slug';
import { PROFILES, type ApiError, type PrereqResult, type SessionInfo, type StateMessage } from '../shared/protocol';
import { saveLanguage } from './config';

export interface Context {
  getPort(): number;
  token: string;
  ptys: PtyManager;
  store: PlanStore;
  planName: string;
  planRoot: string;
  claudeCommand: string[];
  bypass: boolean;
  language: string;
  bundles: Bundles;
  uiDist: string;
  testMode: boolean;
  configPath: string;
  planIsRepo: boolean;
  getPrereq(): PrereqResult[] | null;
  /** Resolves with the checks, waiting for the startup run if it has not finished (unknown is never ok, P7). */
  ensurePrereq(): Promise<PrereqResult[]>;
  refreshPrereq(): Promise<PrereqResult[]>;
  setLanguage(language: string): void;
  needsSetup(): boolean;
  broadcastState(): void;
}

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.js.map': { file: 'app.js.map', type: 'application/json' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/xterm.css': { file: 'xterm.css', type: 'text/css; charset=utf-8' },
};

export function buildState(ctx: Context): StateMessage {
  const status = (slug: string) => (ctx.ptys.status(slug) === 'running' ? 'running' : 'exited');
  const main: SessionInfo = { slug: ctx.planName, profile: 'main', role: 'main', status: status(ctx.planName) };
  // Only sessions of this run: agents saved by an earlier run are history (resume is Phase 6) and keep their slug reserved.
  const agents: SessionInfo[] = ctx.store.listAgents().filter((a) => ctx.ptys.status(a.slug) !== 'unknown').map((a) => ({ slug: a.slug, profile: a.profile, role: 'agent', status: status(a.slug) }));
  return {
    type: 'state', plan: { name: ctx.planName }, main, agents, language: ctx.language, languages: [...ctx.bundles.keys()].sort(), profiles: PROFILES,
    prereq: ctx.getPrereq(), needsSetup: ctx.needsSetup(), planIsRepo: ctx.planIsRepo, planRoot: ctx.planRoot,
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}
const fail = (res: ServerResponse, status: number, code: string, params?: ApiError['params']) =>
  send(res, status, params ? { code, params } : { code });

function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export function createRequestHandler(ctx: Context) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isAllowedHost(req.headers.host, ctx.getPort())) return fail(res, 403, 'forbidden');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${ctx.getPort()}`);
    const path = url.pathname;

    // Static UI files: no token needed, the page itself carries the token in its URL.
    const asset = req.method === 'GET' ? STATIC[path] : undefined;
    if (asset) {
      const file = join(ctx.uiDist, asset.file);
      if (!existsSync(file)) return fail(res, 404, 'not_found');
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
      res.end(readFileSync(file));
      return;
    }

    // UI texts are not secret and the page needs them to explain a wrong token, so they only need the Host check.
    const i18n = /^\/i18n\/(\w+)$/.exec(path);
    if (req.method === 'GET' && i18n) {
      const payload = bundlePayload(ctx.bundles, i18n[1]!);
      return payload ? send(res, 200, payload) : fail(res, 404, 'not_found');
    }

    const token = extractToken(req.headers, url);
    if (!token || !tokensEqual(token, ctx.token)) return fail(res, 401, 'unauthorized');

    if (req.method === 'GET' && path === '/api/state') return send(res, 200, buildState(ctx));

    if (req.method === 'GET' && ctx.testMode) {
      const snap = /^\/api\/debug\/snapshot\/([a-z0-9-]+)$/.exec(path);
      if (snap) return send(res, 200, { text: ctx.ptys.snapshot(snap[1]!).toString('utf8') });
      const size = /^\/api\/debug\/size\/([a-z0-9-]+)$/.exec(path);
      if (size) return send(res, 200, ctx.ptys.size(size[1]!) ?? {});
    }

    if (req.method === 'POST' && path === '/api/agents') {
      let body: unknown;
      try { body = await readBody(req); } catch { return fail(res, 400, 'bad_request'); }
      const b = (typeof body === 'object' && body !== null ? body : {}) as { slug?: unknown; profile?: unknown };
      const blocked = (await ctx.ensurePrereq()).find((c) => c.required && c.status !== 'ok');
      if (blocked) return fail(res, 422, 'prereq.blocked', { tool: blocked.id });
      const existing = [ctx.planName, ...ctx.store.listAgents().map((a) => a.slug)];
      const v = validateSlug(b.slug, existing);
      if (!v.ok) return fail(res, 422, v.code, v.params);
      if (typeof b.profile !== 'string' || !(PROFILES as readonly string[]).includes(b.profile)) {
        return fail(res, 422, 'profile.invalid');
      }
      const launch = buildClaudeLaunch({
        command: ctx.claudeCommand, role: 'agent', slug: v.slug, plan: ctx.planName,
        url: `http://127.0.0.1:${ctx.getPort()}`, token: ctx.token, bypass: ctx.bypass, baseEnv: process.env,
      });
      try {
        ctx.ptys.spawn({ id: v.slug, ...launch, cwd: ctx.planRoot, cols: 120, rows: 30 });
      } catch (e) {
        return fail(res, 500, 'agent.spawnFailed', { reason: e instanceof Error ? e.message : String(e) });
      }
      try {
        ctx.store.addAgent({ slug: v.slug, profile: b.profile });
      } catch (e) {
        await ctx.ptys.discard(v.slug); // no orphan process: the slug can be retried
        return fail(res, 500, 'agent.spawnFailed', { reason: e instanceof Error ? e.message : String(e) });
      }
      ctx.broadcastState();
      return send(res, 201, { slug: v.slug });
    }

    if (req.method === 'POST' && path === '/api/prereq/recheck') return send(res, 200, await ctx.refreshPrereq());

    if (req.method === 'PUT' && path === '/api/config') {
      let body: unknown;
      try { body = await readBody(req); } catch { return fail(res, 400, 'bad_request'); }
      const language = (body as { language?: unknown } | null)?.language;
      if (typeof language !== 'string' || (language !== 'auto' && !ctx.bundles.has(language))) return fail(res, 422, 'config.invalid', { path: 'language' });
      const saved = saveLanguage(ctx.configPath, language);
      if (!saved.ok) return fail(res, 409, saved.code);
      ctx.setLanguage(language);
      ctx.broadcastState();
      return send(res, 200, { language });
    }

    return fail(res, 404, 'not_found');
  };
}
