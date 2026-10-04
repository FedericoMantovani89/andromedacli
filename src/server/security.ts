import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export const createToken = (): string => randomBytes(32).toString('base64url');

export function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Host header must be loopback on our port: blocks DNS-rebinding (SPEC 4.5). */
export const isAllowedHost = (host: string | undefined, port: number): boolean =>
  host === `127.0.0.1:${port}` || host === `localhost:${port}`;

/** Browsers always send Origin on WebSocket upgrades; a foreign or missing one is refused. */
export const isAllowedOrigin = (origin: string | undefined, port: number): boolean =>
  origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;

export function extractToken(headers: IncomingHttpHeaders, url: URL): string | undefined {
  const auth = headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return url.searchParams.get('token') ?? undefined;
}
