import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Inbox } from './agents/inbox';
import type { AgentRegistry } from './agents/registry';
import type { ModEvent } from '../shared/activity';
import { extractToken, type SessionTokens } from './security';
import { fail, readBody, send } from './http-util';
import type { QuestionQueue } from './questions/queue';

export type ToolHandler = (slug: string, body: unknown) => Promise<unknown>;

export interface V1Context {
  tokens: SessionTokens;
  inbox: Inbox;
  registry: AgentRegistry;
  questions: QuestionQueue;
  /** Everything that must react to a mod event (registry, reading store, scheduler...). */
  handleModEvent(slug: string, e: ModEvent): void;
  tools: Record<string, ToolHandler>;
}

const EVENT_TYPES: ModEvent['type'][] = ['session.start', 'session.end', 'turn.start', 'turn.complete'];

/** Which role may call which console tool (SPEC 13.4). An agent's native AskUserQuestion reaches ask_user through the mod. */
const TOOL_ROLES: Record<string, ('main' | 'agent')[]> = {
  spawn_agent: ['main'],
  list_agents: ['main', 'agent'],
  ask_user: ['main', 'agent'],
};

/**
 * The channel mod -> console. Authenticated by the per-session token only: the UI token does not work here, and the
 * caller can only ever act as the session its token was issued to (the body never names the actor).
 */
export async function handleV1(ctx: V1Context, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const token = extractToken(req.headers, url);
  const slug = token ? ctx.tokens.slugFor(token) : undefined;
  if (!slug) return fail(res, 401, 'unauthorized');
  const path = url.pathname;

  if (req.method === 'POST' && path === '/v1/events') {
    let body: unknown;
    // turn.complete carries the whole final answer: allow well above the 200 KiB the reading store keeps (JSON escaping adds more).
    try { body = await readBody(req, 2 * 1024 * 1024); } catch { return fail(res, 400, 'bad_request'); }
    const b = (typeof body === 'object' && body !== null ? body : {}) as { type?: unknown; sessionId?: unknown; data?: unknown };
    if (!EVENT_TYPES.includes(b.type as ModEvent['type']) || typeof b.sessionId !== 'string') return fail(res, 400, 'bad_request');
    const data = typeof b.data === 'object' && b.data !== null ? (b.data as Record<string, unknown>) : undefined;
    ctx.handleModEvent(slug, { type: b.type as ModEvent['type'], sessionId: b.sessionId, data });
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && path === '/v1/inbox') return send(res, 200, { messages: ctx.inbox.pending(slug) });

  if (req.method === 'POST' && path === '/v1/ack') {
    let body: unknown;
    try { body = await readBody(req); } catch { return fail(res, 400, 'bad_request'); }
    const id = (body as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !ctx.inbox.ack(slug, id)) return fail(res, 404, 'not_found');
    res.writeHead(204);
    res.end();
    return;
  }

  const question = /^\/v1\/questions\/([\w-]+)$/.exec(path);
  if (req.method === 'GET' && question) {
    // Short long-polls (at most 20 s each): the mod repeats them, so no single call hangs for long.
    const seconds = Math.min(Math.max(Number(url.searchParams.get('wait')) || 0, 0), 20);
    return send(res, 200, await ctx.questions.wait(question[1]!, seconds * 1000, slug));
  }

  const tool = /^\/v1\/tools\/(\w+)$/.exec(path);
  if (req.method === 'POST' && tool) {
    const name = tool[1]!;
    const allowed = TOOL_ROLES[name];
    if (!allowed) return fail(res, 404, 'not_found');
    const role = ctx.registry.get(slug)?.role;
    if (!role || !allowed.includes(role)) return fail(res, 403, 'forbidden');
    const handler = ctx.tools[name];
    if (!handler) return fail(res, 404, 'not_found');
    let body: unknown;
    try { body = await readBody(req); } catch { return fail(res, 400, 'bad_request'); }
    try {
      return send(res, 200, await handler(slug, body));
    } catch {
      return fail(res, 500, 'internal');
    }
  }

  return fail(res, 404, 'not_found');
}
