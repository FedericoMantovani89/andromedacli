import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { extractToken, isAllowedHost, isAllowedOrigin, tokensEqual } from './security';
import { buildState, type Context } from './http';
import type { ResizeMessage } from '../shared/protocol';

function reject(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** Two socket kinds (SPEC 4.1): binary terminal bytes per session, and JSON UI state. */
export function attachWebSockets(server: Server, ctx: Context): { broadcastState(): void; broadcastJson(payload: unknown): void; closeAll(): void } {
  const wss = new WebSocketServer({ noServer: true });
  const uiSockets = new Set<WebSocket>();

  const broadcastState = () => {
    const payload = JSON.stringify(buildState(ctx));
    for (const ws of uiSockets) if (ws.readyState === ws.OPEN) ws.send(payload);
  };

  const broadcastJson = (payload: unknown) => {
    const text = JSON.stringify(payload);
    for (const ws of uiSockets) if (ws.readyState === ws.OPEN) ws.send(text);
  };

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      handleUpgrade(req, socket, head);
    } catch {
      reject(socket, 400, 'Bad Request'); // an exception here would otherwise take every terminal down
    }
  });

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const port = ctx.getPort();
    if (!isAllowedHost(req.headers.host, port)) return reject(socket, 403, 'Forbidden');
    if (!isAllowedOrigin(req.headers.origin, port)) return reject(socket, 403, 'Forbidden');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const token = extractToken(req.headers, url);
    if (!token || !tokensEqual(token, ctx.token)) return reject(socket, 401, 'Unauthorized');

    const term = /^\/ws\/term\/([a-z0-9-]+)$/.exec(url.pathname);
    if (url.pathname === '/ws/ui') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        uiSockets.add(ws);
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
    closeAll: () => { for (const ws of wss.clients) ws.terminate(); wss.close(); },
  };
}
