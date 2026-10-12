import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiError } from '../shared/protocol';
import { isObj } from '../shared/guards';

export function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

export const fail = (res: ServerResponse, status: number, code: string, params?: ApiError['params']): void =>
  send(res, status, params ? { code, params } : { code });

/** Reads the request body as bytes; past `limit` the rest is drained, not kept, so the client still gets a proper error response. */
export function readRaw(req: IncomingMessage, limit: number): Promise<{ bytes: Buffer; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { tooLarge = true; chunks.length = 0; } else if (!tooLarge) chunks.push(c);
    });
    req.on('end', () => resolve({ bytes: Buffer.concat(chunks), tooLarge }));
    req.on('error', reject);  });
}

/** Reads a JSON body of at most `limit` bytes; rejects on oversize or malformed JSON. */
export async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const { bytes, tooLarge } = await readRaw(req, limit);
  if (tooLarge) throw new Error('too large');
  return JSON.parse(bytes.toString('utf8') || 'null');
}

/** Reads the JSON body; on failure it answers 400 `bad_request` itself and returns undefined (a valid body is never undefined). */
export async function readBodyOr400(req: IncomingMessage, res: ServerResponse, limit?: number): Promise<unknown> {
  try { return await readBody(req, limit); } catch { fail(res, 400, 'bad_request'); return undefined; }
}

/** Like `readBodyOr400`, and the body must be a JSON object (not null, not an array). */
export async function readObjectBody(req: IncomingMessage, res: ServerResponse, limit?: number): Promise<Record<string, unknown> | undefined> {
  const body = await readBodyOr400(req, res, limit);
  if (body === undefined) return undefined;
  if (!isObj(body)) { fail(res, 400, 'bad_request'); return undefined; }
  return body;
}
