import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { extractToken, isAllowedHost, isAllowedOrigin, tokensEqual } from './security';
import { buildState, type Context, type ProjectResolver } from './http';
import { coalesce } from './coalesce';
import type { ResizeMessage } from '../shared/protocol';

function reject(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** Two socket kinds (SPEC 4.1): binary terminal bytes per session, and JSON UI state. */
export function attachWebSockets(server: Server, source: Context | ProjectResolver): { broadcastState(): void; broadcastJson(payload: unknown, project?: string): void; closeProject(name: string): void; closeAll(): void } {
  const resolve: ProjectResolver = typeof source === 'function' ? source : () => source;
  const wss = new WebSocketServer({ noServer: true });
  // Each UI socket belongs to the project it asked for (`?project=`) and gets that project's state; terminals too.
  const uiSockets = new Map<WebSocket, string>();
  const termSockets = new Map<WebSocket, string>();
  const projectOf = (url: URL): Context | undefined => resolve(url.searchParams.get('project') ?? undefined);

  // Any change in any project pushes to every socket: the tab dots of the other projects need it.
  // Changes close together become one push (at most one every 25 ms) and the state is built once per project, not once per socket (SPEC 33.2).
  const flushState = (): void => {
    const built = new Map<string, string | null>();
    for (const [ws, project] of uiSockets) {
      if (ws.readyState !== ws.OPEN) continue;
      if (!built.has(project)) {
        const projectCtx = resolve(project);
        built.set(project, projectCtx ? JSON.stringify(buildState(projectCtx)) : null);
      }
      const text = built.get(project);
      if (text) ws.send(text);
      else ws.close(); // its project was closed
    }
  };
  const push = coalesce(flushState, 25);
  const broadcastState = (): void => push.trigger();

  /** A message about one project (a reading entry) only goes to the sockets of that project. */
  const broadcastJson = (payload: unknown, project?: string) => {
    const text = JSON.stringify(payload);
    for (const [ws, p] of uiSockets) if (ws.readyState === ws.OPEN && (project === undefined || p === project)) ws.send(text);
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
    const ctx = projectOf(url);
    if (!ctx) return reject(socket, 404, 'Not Found');

    const term = /^\/ws\/term\/([a-z0-9-]+)$/.exec(url.pathname);
    if (url.pathname === '/ws/ui') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        uiSockets.set(ws, ctx.projectName);
        ws.on('close', () => uiSockets.delete(ws));
        ws.send(JSON.stringify(buildState(ctx)));
      });
      return;
    }
    if (term) {
      const id = term[1]!;
      // A project's own sessions first, then the console-wide utility terminals (assisted installs), which take no keyboard input.
      const utility = ctx.ptys.status(id) === 'unknown' && ctx.utilityPtys.status(id) !== 'unknown';
      const pm = utility ? ctx.utilityPtys : ctx.ptys;
      if (pm.status(id) === 'unknown') return reject(socket, 404, 'Not Found');
      wss.handleUpgrade(req, socket, head, (ws) => {
        termSockets.set(ws, ctx.projectName);
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
    closeProject: (name) => { for (const m of [uiSockets, termSockets]) for (const [ws, project] of m) if (project === name) ws.terminate(); },
    closeAll: () => { push.cancel(); for (const ws of wss.clients) ws.terminate(); wss.close(); },
  };
}
