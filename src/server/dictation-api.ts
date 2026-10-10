import type { IncomingMessage, ServerResponse } from 'node:http';
import { audioMime, MAX_AUDIO_BYTES, transcribe, type DictationCode } from './dictation';
import { fail, readBody, send } from './http-util';
import { hasGroqKey, isValidGroqKey, readGroqKey, writeGroqKey } from './secrets';

/** The routes of the voice dictation that are not about one project: the secrets and the transcription. The token and Host checks already ran. */
export interface DictationHost {
  configDir: string;
  /** The network call to Groq; tests inject a fake (no network, no real key). */
  groqFetch?: typeof fetch;
}

/** The HTTP status of each transcription error; the body is always `{ status: 'error', code }`. */
const STATUS: Partial<Record<DictationCode, number>> = {
  'dictation.noKey': 409, 'dictation.tooLarge': 413, 'dictation.emptyAudio': 422, 'dictation.badType': 415, 'dictation.noSpeech': 422,
  'dictation.groqRejected': 502, 'dictation.network': 502, 'dictation.timeout': 504,
};
const sendError = (res: ServerResponse, code: DictationCode): void => send(res, STATUS[code] ?? 500, { status: 'error', code });

/** Reads the request body as bytes, giving up as soon as it is over `limit` (the rest is drained, not kept). */
function readBytes(req: IncomingMessage, limit: number): Promise<Buffer | 'too_large'> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; } else if (!over) chunks.push(c);
    });
    req.on('end', () => resolve(over ? 'too_large' : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Answers `GET/PUT /api/secrets` and `POST /api/dictation/transcribe`; returns false for any other path. */
export async function handleDictationRoute(host: DictationHost, req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<boolean> {
  if (path === '/api/secrets') {
    if (req.method === 'GET') { send(res, 200, { groq: { set: hasGroqKey(host.configDir) } }); return true; }
    if (req.method === 'PUT') {
      let body: unknown;
      try { body = await readBody(req); } catch { fail(res, 400, 'bad_request'); return true; }
      const wanted = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { groqKey?: unknown }).groqKey : undefined;
      if (wanted === undefined || (wanted !== null && typeof wanted !== 'string')) { fail(res, 400, 'bad_request'); return true; }
      if (wanted !== null && !isValidGroqKey(wanted)) { fail(res, 422, 'dictation.keyInvalid'); return true; }
      if (url.searchParams.get('dryRun') !== '1') writeGroqKey(host.configDir, wanted); // a dry run only checks (Options saves in two passes)
      send(res, 200, { groq: { set: url.searchParams.get('dryRun') === '1' ? hasGroqKey(host.configDir) : wanted !== null } });
      return true;
    }
    return false;
  }
  if (req.method === 'POST' && path === '/api/dictation/transcribe') {
    const declared = Number(req.headers['content-length']);
    const tooBig = (): void => { req.resume(); sendError(res, 'dictation.tooLarge'); };
    // Everything that can be refused is refused before the body is read, and the key is not even read for a request that cannot succeed.
    const mime = audioMime(req.headers['content-type']);
    if (!mime) { req.resume(); sendError(res, 'dictation.badType'); return true; }
    if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) { tooBig(); return true; }
    const key = readGroqKey(host.configDir);
    if (!key) { req.resume(); sendError(res, 'dictation.noKey'); return true; }
    let audio: Buffer | 'too_large';
    try { audio = await readBytes(req, MAX_AUDIO_BYTES); } catch { fail(res, 400, 'bad_request'); return true; }
    if (audio === 'too_large') { sendError(res, 'dictation.tooLarge'); return true; }
    const language = url.searchParams.get('lang') ?? undefined;
    const out = await transcribe({ fetch: host.groqFetch ?? fetch, key, audio, mime, ...(language ? { language } : {}) });
    if (out.status === 'ok') send(res, 200, out); else sendError(res, out.code);
    return true;
  }
  return false;
}
