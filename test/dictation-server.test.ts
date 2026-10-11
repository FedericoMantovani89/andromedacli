// Voice dictation, server side: the global secrets file, the text sanitiser, the Groq client (a fake fetch: no network, no real key) and the routes.
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { hasGroqKey, isValidGroqKey, readGroqKey, secretsPath, writeGroqKey } from '../src/server/secrets';
import { MAX_AUDIO_BYTES, sanitizeForTerminal, transcribe, typeIntoSession } from '../src/server/dictation';
import { USER_ERROR_CODES } from '../src/shared/protocol';
import { autoClose, bootServer, ui, type Running } from './helpers';

vi.setConfig({ testTimeout: 60_000 });
autoClose();

const KEY = 'gsk_TESTKEY_not_a_real_key_0123456789';
const tmp = (): string => mkdtempSync(join(tmpdir(), 'dict-'));

interface Call { url: string; init: RequestInit }
/** A fake Groq: records what was sent and answers with the given JSON (or throws). */
function fakeGroq(answer: { status?: number; body?: unknown; throws?: Error } = {}) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (answer.throws) throw answer.throws;
    return new Response(JSON.stringify(answer.body ?? { text: ' hello world ' }), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchFn };
}

// ---- the secrets file
it('keeps the Groq key in its own file under the config folder, not readable by others, and never in config.json', () => {
  const dir = tmp();
  expect(hasGroqKey(dir)).toBe(false);
  writeGroqKey(dir, KEY);
  expect(hasGroqKey(dir)).toBe(true);
  expect(readGroqKey(dir)).toBe(KEY);
  expect(secretsPath(dir)).toBe(join(dir, 'secrets.json'));
  expect(readdirSync(dir)).toEqual(['secrets.json']); // no temp file left behind
  if (process.platform !== 'win32') expect(statSync(secretsPath(dir)).mode & 0o077).toBe(0);
  writeGroqKey(dir, null);
  expect(hasGroqKey(dir)).toBe(false);
  expect(readGroqKey(dir)).toBeUndefined();
});
it('treats an unreadable secrets file as no key', () => {
  const dir = tmp();
  writeGroqKey(dir, KEY);
  writeFileSync(secretsPath(dir), '{ not json');
  expect(readGroqKey(dir)).toBeUndefined();
});
it('accepts only a plausible key: printable, no spaces, bounded length', () => {
  expect(isValidGroqKey(KEY)).toBe(true);
  for (const bad of ['', 'short', 'has space in the key', `${KEY}\n`, 'x'.repeat(300), 'chiave-è-non-ascii-1234567', 42, null, undefined]) expect(isValidGroqKey(bad)).toBe(false);
});

// ---- what may reach the terminal
it('turns a transcript into one line of plain text: no escape sequences, no Enter, no control characters', () => {
  expect(sanitizeForTerminal('hello\x1b[31m world\r\nrm -rf /\n')).toBe('hello[31m world rm -rf /');
  expect(sanitizeForTerminal('a\x1b[201~b')).toBe('a[201~b');
  expect(sanitizeForTerminal('tab\there\x00nul\x7fdel\x9bcsi\u2028ls\u2029x')).toBe('tab herenuldelcsi ls x');
  expect(sanitizeForTerminal('  many   spaces \u202eevil\u202c ')).toBe('many spaces evil');
  expect(sanitizeForTerminal('perché è così — ok')).toBe('perché è così — ok');
  expect(sanitizeForTerminal('x'.repeat(50_000))).toHaveLength(20_000);
  expect(sanitizeForTerminal('\r\n\x1b')).toBe('');
});
it('writes the clean text to a running session without a trailing newline, and refuses a session that is not running', () => {
  const written: string[] = [];
  const ptys = { status: () => 'running' as const, write: (_id: string, d: Buffer | string) => { written.push(String(d)); } };
  expect(typeIntoSession(ptys, 'shop-api', 'fix it\r\nnow\x1b[2J')).toEqual({ status: 'ok' });
  expect(written).toEqual(['fix it now[2J']);
  expect(written[0]).not.toMatch(/[\r\n\x1b]/);
  expect(typeIntoSession(ptys, 'shop-api', '\r\n \x1b')).toEqual({ status: 'error', code: 'dictation.textEmpty' });
  expect(typeIntoSession({ ...ptys, status: () => 'exited' as const }, 'shop-api', 'x')).toEqual({ status: 'error', code: 'dictation.mainNotRunning' });
  expect(written).toHaveLength(1);
});

// ---- the Groq client
it('sends the audio to Groq as multipart with the key only in the Authorization header', async () => {
  const g = fakeGroq();
  const out = await transcribe({ fetch: g.fetchFn, key: KEY, audio: Buffer.from('audio-bytes'), mime: 'audio/webm;codecs=opus', language: 'it' });
  expect(out).toEqual({ status: 'ok', text: 'hello world' });
  expect(g.calls).toHaveLength(1);
  const { url, init } = g.calls[0]!;
  expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
  expect(init.method).toBe('POST');
  expect((init.headers as Record<string, string>).authorization ?? (init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  const form = init.body as FormData;
  expect(form.get('model')).toBe('whisper-large-v3-turbo');
  expect(form.get('response_format')).toBe('json');
  expect(form.get('language')).toBe('it');
  const file = form.get('file') as File;
  expect(file.name).toBe('audio.webm');
  expect(Buffer.from(await file.arrayBuffer()).toString()).toBe('audio-bytes');
  expect(JSON.stringify([...form.keys()].map((k) => form.get(k) instanceof File ? k : [k, form.get(k)]))).not.toContain(KEY);
  expect(init.signal).toBeDefined();
});
it('leaves the language out when it is not a plain language code', async () => {
  for (const language of [undefined, 'auto', 'IT', 'italian', '']) {
    const g = fakeGroq();
    await transcribe({ fetch: g.fetchFn, key: KEY, audio: Buffer.from('a'), mime: 'audio/webm', ...(language !== undefined ? { language } : {}) });
    expect((g.calls[0]!.init.body as FormData).has('language')).toBe(false);
  }
});
it('refuses empty and oversized audio before any network call', async () => {
  const g = fakeGroq();
  expect(await transcribe({ fetch: g.fetchFn, key: KEY, audio: Buffer.alloc(0), mime: 'audio/webm' })).toEqual({ status: 'error', code: 'dictation.emptyAudio' });
  expect(await transcribe({ fetch: g.fetchFn, key: KEY, audio: Buffer.alloc(MAX_AUDIO_BYTES + 1), mime: 'audio/webm' })).toEqual({ status: 'error', code: 'dictation.tooLarge' });
  expect(g.calls).toHaveLength(0);
});
it('maps Groq failures to codes and never lets the key or Groq\'s own text out', async () => {
  const cases: [Parameters<typeof fakeGroq>[0], string][] = [
    [{ status: 401, body: { error: { message: `Invalid API Key ${KEY}` } } }, 'dictation.groqRejected'],
    [{ status: 429, body: { error: { message: 'rate' } } }, 'dictation.groqRejected'],
    [{ status: 500, body: 'oops' }, 'dictation.groqRejected'],
    [{ status: 200, body: { text: '   ' } }, 'dictation.noSpeech'],
    [{ status: 200, body: { nothing: true } }, 'dictation.noSpeech'],
    [{ throws: new Error(`connect ECONNREFUSED ${KEY}`) }, 'dictation.network'],
    [{ throws: Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }) }, 'dictation.timeout'],
  ];
  for (const [answer, code] of cases) {
    const out = await transcribe({ fetch: fakeGroq(answer).fetchFn, key: KEY, audio: Buffer.from('a'), mime: 'audio/webm' });
    expect(out).toEqual({ status: 'error', code });
    expect(JSON.stringify(out)).not.toContain(KEY);
  }
});
it('gives up after the timeout', async () => {
  const hang = ((_u: unknown, init?: RequestInit) => new Promise((_res, rej) => { init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); })) as typeof fetch;
  expect(await transcribe({ fetch: hang, key: KEY, audio: Buffer.from('a'), mime: 'audio/webm', timeoutMs: 20 })).toEqual({ status: 'error', code: 'dictation.timeout' });
});

// ---- the routes
const bootWith = (g: ReturnType<typeof fakeGroq>, configDir = tmp()): Promise<Running> => bootServer({ configDir, groqFetch: g.fetchFn });
const upload = (s: Running, body: Buffer | string, o: { type?: string; lang?: string; token?: string | null; host?: string } = {}): Promise<{ status: number; body: any }> =>
  fetch(`http://127.0.0.1:${s.port}/api/dictation/transcribe${o.lang ? `?lang=${o.lang}` : ''}`, {
    method: 'POST',
    headers: { ...(o.token === null ? {} : { authorization: `Bearer ${o.token ?? s.token}` }), 'content-type': o.type ?? 'audio/webm;codecs=opus', ...(o.host ? { host: o.host } : {}) },
    body: body as BodyInit,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

it('reports whether a key is set, never the key; saves, replaces and clears it, checking first with ?dryRun=1', async () => {
  const dir = tmp();
  const s = await bootWith(fakeGroq(), dir);
  expect((await ui(s, '/api/secrets')).body).toEqual({ groq: { set: false } });
  expect((await ui(s, '/api/secrets?dryRun=1', 'PUT', { groqKey: KEY })).status).toBe(200);
  expect(hasGroqKey(dir)).toBe(false); // a dry run writes nothing
  const bad = await ui(s, '/api/secrets', 'PUT', { groqKey: 'has spaces' });
  expect(bad).toMatchObject({ status: 422, body: { code: 'dictation.keyInvalid' } });
  expect((await ui(s, '/api/secrets', 'PUT', { groqKey: KEY })).body).toEqual({ groq: { set: true } });
  expect(readGroqKey(dir)).toBe(KEY);
  expect((await ui(s, '/api/secrets')).body).toEqual({ groq: { set: true, preview: 'gsk_T*****' } }); // five characters and stars, never the key
  expect((await ui(s, '/api/secrets', 'PUT', { nothing: 1 })).status).toBe(400);
  expect((await ui(s, '/api/secrets', 'PUT', { groqKey: null })).body).toEqual({ groq: { set: false } });
  expect(existsSync(secretsPath(dir)) ? readGroqKey(dir) : undefined).toBeUndefined();
});
it('the key is in no response of the console and not in config.json, the options payload or the state', async () => {
  const dir = tmp();
  const s = await bootWith(fakeGroq(), dir);
  await ui(s, '/api/secrets', 'PUT', { groqKey: KEY });
  for (const path of ['/api/secrets', '/api/options', '/api/state', '/api/host', '/api/templates']) expect(JSON.stringify((await ui(s, path)).body)).not.toContain(KEY);
  expect(readFileSync(join(dir, 'config.json'), 'utf8')).not.toContain(KEY);
  const sneaky = await ui(s, '/api/config', 'PUT', { secrets: { groqKey: KEY }, groqKey: KEY });
  expect(sneaky.status).toBe(422); // the generic config patch cannot write secrets
  expect(readFileSync(join(dir, 'config.json'), 'utf8')).not.toContain(KEY);
});
it('needs the token and an allowed Host, on every dictation route', async () => {
  const s = await bootWith(fakeGroq());
  expect((await upload(s, 'abc', { token: null })).status).toBe(401);
  expect((await upload(s, 'abc', { token: 'wrong' })).status).toBe(401);
  expect((await fetch(`http://127.0.0.1:${s.port}/api/secrets`)).status).toBe(401);
  expect((await fetch(`http://127.0.0.1:${s.port}/api/secrets`, { method: 'PUT', body: '{}' })).status).toBe(401);
  expect((await fetch(`http://127.0.0.1:${s.port}/api/main/input`, { method: 'POST', body: '{}' })).status).toBe(401);
});
it('refuses to transcribe without a key and does not call Groq', async () => {
  const g = fakeGroq();
  const s = await bootWith(g);
  const r = await upload(s, 'abc');
  expect(r).toMatchObject({ status: 409, body: { status: 'error', code: 'dictation.noKey' } });
  expect(g.calls).toHaveLength(0);
});
it('transcribes with the saved key and the language hint, and answers { status, text }', async () => {
  const g = fakeGroq({ body: { text: 'ciao mondo' } });
  const s = await bootWith(g);
  await ui(s, '/api/secrets', 'PUT', { groqKey: KEY });
  const r = await upload(s, Buffer.from('some-audio'), { lang: 'it' });
  expect(r).toEqual({ status: 200, body: { status: 'ok', text: 'ciao mondo' } });
  expect(g.calls).toHaveLength(1);
  expect((g.calls[0]!.init.body as FormData).get('language')).toBe('it');
  expect(JSON.stringify(r.body)).not.toContain(KEY);
});
it('enforces the size limit before the network call (by Content-Length and while reading) and refuses empty and non-audio bodies', async () => {
  const g = fakeGroq();
  const s = await bootWith(g);
  await ui(s, '/api/secrets', 'PUT', { groqKey: KEY });
  expect(await upload(s, Buffer.alloc(MAX_AUDIO_BYTES + 1))).toMatchObject({ status: 413, body: { status: 'error', code: 'dictation.tooLarge' } });
  expect(await upload(s, Buffer.alloc(0))).toMatchObject({ status: 422, body: { status: 'error', code: 'dictation.emptyAudio' } });
  expect(await upload(s, 'abc', { type: 'application/json' })).toMatchObject({ status: 415, body: { status: 'error', code: 'dictation.badType' } });
  expect(g.calls).toHaveLength(0);
});
it('turns a Groq failure into an error code with the right status and no key in the answer', async () => {
  const s = await bootWith(fakeGroq({ status: 401, body: { error: { message: KEY } } }));
  await ui(s, '/api/secrets', 'PUT', { groqKey: KEY });
  const r = await upload(s, 'abc');
  expect(r).toMatchObject({ status: 502, body: { status: 'error', code: 'dictation.groqRejected' } });
  expect(JSON.stringify(r.body)).not.toContain(KEY);
});
it('types the text into the main without Enter, and refuses empty text or a bad body', async () => {
  const s = await bootWith(fakeGroq());
  expect((await ui(s, '/api/main/input', 'POST', { text: 'fix the login\r\nthen\x1b[2J stop' })).body).toEqual({ status: 'ok' });
  expect((await ui(s, '/api/main/input', 'POST', { text: '\r\n' }))).toMatchObject({ status: 422, body: { code: 'dictation.textEmpty' } });
  expect((await ui(s, '/api/main/input', 'POST', { text: 5 })).status).toBe(400);
});
it('every dictation error code is a user-facing code with a translation', () => {
  for (const c of ['dictation.noKey', 'dictation.tooLarge', 'dictation.emptyAudio', 'dictation.badType', 'dictation.groqRejected', 'dictation.timeout', 'dictation.noSpeech', 'dictation.network', 'dictation.keyInvalid', 'dictation.mainNotRunning', 'dictation.textEmpty']) expect(USER_ERROR_CODES).toContain(c);
});
