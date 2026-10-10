import type { PtyManager } from './pty/pty-manager';

/** Voice dictation: the call to Groq Whisper and the text that may be typed into a terminal. */

export const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
export const GROQ_MODEL = 'whisper-large-v3-turbo';
/** Groq's own limit for an uploaded file; larger audio is refused here, before any network call. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const GROQ_TIMEOUT_MS = 60_000;
/** The longest text typed into a terminal in one go. */
export const MAX_TYPED_CHARS = 20_000;

export type DictationCode =
  | 'dictation.noKey' | 'dictation.tooLarge' | 'dictation.emptyAudio' | 'dictation.badType' | 'dictation.groqRejected'
  | 'dictation.timeout' | 'dictation.noSpeech' | 'dictation.network' | 'dictation.keyInvalid' | 'dictation.mainNotRunning' | 'dictation.textEmpty';

export type Transcription = { status: 'ok'; text: string } | { status: 'error'; code: DictationCode };

/** The audio containers a browser recorder produces (and Groq reads), with the file extension Groq uses to recognise them. */
const EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/m4a': 'm4a',
};

/** `audio/webm;codecs=opus` -> `audio/webm`; undefined when it is not an audio type the console accepts. */
export function audioMime(contentType: string | undefined): string | undefined {
  const base = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  return base in EXTENSIONS ? base : undefined;
}

/** A plain language code ("it"), as the UI sends; anything else is left out and Whisper detects the language. */
const LANGUAGE = /^[a-z]{2,3}$/;

export interface TranscribeOptions {
  fetch: typeof fetch;
  key: string;
  audio: Buffer;
  mime: string;
  language?: string;
  timeoutMs?: number;
}

/**
 * One transcription. The key travels only in the Authorization header; nothing from Groq's answer (which may echo it) or from an
 * exception is returned or logged: the caller gets a code and nothing else.
 */
export async function transcribe(o: TranscribeOptions): Promise<Transcription> {
  if (o.audio.length === 0) return { status: 'error', code: 'dictation.emptyAudio' };
  if (o.audio.length > MAX_AUDIO_BYTES) return { status: 'error', code: 'dictation.tooLarge' };
  const base = o.mime.split(';')[0]!.trim().toLowerCase();
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(o.audio)], { type: base }), `audio.${EXTENSIONS[base] ?? 'webm'}`);
  form.set('model', GROQ_MODEL);
  form.set('response_format', 'json');
  if (o.language !== undefined && LANGUAGE.test(o.language)) form.set('language', o.language);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? GROQ_TIMEOUT_MS);
  try {
    const res = await o.fetch(GROQ_URL, { method: 'POST', headers: { authorization: `Bearer ${o.key}` }, body: form, signal: controller.signal });
    if (!res.ok) return { status: 'error', code: 'dictation.groqRejected' };
    const body = (await res.json().catch(() => null)) as { text?: unknown } | null;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    return text === '' ? { status: 'error', code: 'dictation.noSpeech' } : { status: 'ok', text };
  } catch (e) {
    return { status: 'error', code: (e as { name?: string } | null)?.name === 'AbortError' ? 'dictation.timeout' : 'dictation.network' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Makes a transcript safe to type into a terminal: one line of plain text. Every control character (ESC, CR, LF, tab, NUL, DEL and the
 * C1 range), the Unicode line separators and the bidirectional overrides are dropped or turned into a space, so nothing in a transcript
 * can end a paste, move the cursor or press Enter.
 */
export function sanitizeForTerminal(text: string): string {
  return text
    .replace(/[\r\n\t\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, MAX_TYPED_CHARS);
}

/**
 * Types the cleaned text into a session's input WITHOUT pressing Enter (the user confirms in the terminal). Plain text, no bracketed
 * paste: it works whether or not the program asked for paste mode, in any state of the session.
 */
export function typeIntoSession(ptys: Pick<PtyManager, 'status' | 'write'>, id: string, text: string): { status: 'ok' } | { status: 'error'; code: DictationCode } {
  const clean = sanitizeForTerminal(text);
  if (clean === '') return { status: 'error', code: 'dictation.textEmpty' };
  if (ptys.status(id) !== 'running') return { status: 'error', code: 'dictation.mainNotRunning' };
  ptys.write(id, clean);
  return { status: 'ok' };
}
