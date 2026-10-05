import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { extractToken, isAllowedHost, isAllowedOrigin, tokensEqual } from './security';
import { buildState, type Context, type PlanResolver } from './http';
import type { ResizeMessage } from '../shared/protocol';

function reject(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** Two socket kinds (SPEC 4.1): binary terminal bytes per session, and JSON UI state. */
export function attachWebSockets(server: Server, source: Context | PlanResolver): { broadcastState(): void; broadcastJson(payload: unknown, plan?: string): void; closePlan(name: string): void; closeAll(): void } {
  const resolve: PlanResolver = typeof source === 'function' ? source : () => source;
  const wss = new WebSocketServer({ noServer: true });
  // Each UI socket belongs to the plan it asked for (`?plan=`) and gets that plan's state; terminals too.
  const uiSockets = new Map<WebSocket, string>();
  const termSockets = new Map<WebSocket, string>();
  const planOf = (url: URL): Context | undefined => resolve(url.searchParams.get('plan') ?? undefined);

  // Any change in any plan pushes to every socket: the tab dots of the other plans need it.
  const broadcastState = () => {
    for (const [ws, plan] of uiSockets) {
      if (ws.readyState !== ws.OPEN) continue;
      const planCtx = resolve(plan);
      if (planCtx) ws.send(JSON.stringify(buildState(planCtx)));
      else ws.close(); // its plan was closed
    }
  };

  /** A message about one plan (a reading entry) only goes to the sockets of that plan. */
  const broadcastJson = (payload: unknown, plan?: string) => {
    const text = JSON.stringify(payload);
    for (const [ws, p] of uiSockets) if (ws.readyState === ws.OPEN && (plan === undefined || p === plan)) ws.send(text);
  };

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      handleUpgrade(req, socket, head);
    } catch {
      reject(socket, 400, 'Bad Request'); // an exception here would otherwise take every terminal down
    }
  });

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const first = resolve();
    if (!first) return reject(socket, 503, 'Service Unavailable');
    const port = first.getPort();
    if (!isAllowedHost(req.headers.host, port)) return reject(socket, 403, 'Forbidden');
    if (!isAllowedOrigin(req.headers.origin, port)) return reject(socket, 403, 'Forbidden');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const token = extractToken(req.headers, url);
    if (!token || !tokensEqual(token, first.token)) return reject(socket, 401, 'Unauthorized');
    const ctx = planOf(url);
    if (!ctx) return reject(socket, 404, 'Not Found');

    const term = /^\/ws\/term\/([a-z0-9-]+)$/.exec(url.pathname);
    if (url.pathname === '/ws/ui') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        uiSockets.set(ws, ctx.planName);
        ws.on('close', () => uiSockets.delete(ws));
        ws.send(JSON.stringify(buildState(ctx)));
      });
      return;
    }
    if (term) {
      const id = term[1]!;
      // A plan's own sessions first, then the console-wide utility terminals (assisted installs), which take no keyboard input.
      const utility = ctx.ptys.status(id) === 'unknown' && ctx.utilityPtys.status(id) !== 'unknown';
      const pm = utility ? ctx.utilityPtys : ctx.ptys;
      if (pm.status(id) === 'unknown') return reject(socket, 404, 'Not Found');
      wss.handleUpgrade(req, socket, head, (ws) => {
        termSockets.set(ws, ctx.planName);
        ws.on('close', () => termSockets.delete(ws));
        const snapshot = pm.snapshot(id);
        if (snapshot.length > 0) ws.send(snapshot, { binary: true });
        const unsubscribe = pm.subscribe(id, (chunk) => {
          if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
        });
        ws.on('message', (data: Buffer, isBinary: boolean) => {
          if (isBinary) { if (!utility) pm.write(id, data); return; }
          try {
            const msg = JSON.parse(data.toString('utf8')) as ResizeMessage;
            if (msg.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
              pm.resize(id, msg.cols, msg.rows);
            }
          } catch { /* ignore malformed control frames */ }
        });
        ws.on('close', unsubscribe);
      });
      return;
    }
    reject(socket, 404, 'Not Found');
  };

  return {
    broadcastState,
    broadcastJson,
    closePlan: (name) => { for (const m of [uiSockets, termSockets]) for (const [ws, plan] of m) if (plan === name) ws.terminate(); },
    closeAll: () => { for (const ws of wss.clients) ws.terminate(); wss.close(); },
  };
}
