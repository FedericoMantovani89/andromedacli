import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiError } from '../shared/protocol';

export function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

export const fail = (res: ServerResponse, status: number, code: string, params?: ApiError['params']): void =>
  send(res, status, params ? { code, params } : { code });

/** Reads a JSON body of at most `limit` bytes; rejects on oversize or malformed JSON. */
export function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) tooLarge = true; // keep draining (not storing) so the client gets a proper error response
      else chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new Error('too large'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
