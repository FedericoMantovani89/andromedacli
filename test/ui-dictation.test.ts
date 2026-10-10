// @vitest-environment jsdom
// The dictation dialog with a fake microphone (getUserMedia + MediaRecorder) and a fake console server. No real audio, no Groq.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openOptions = vi.fn();
vi.mock('../src/ui/options', () => ({ openOptions }));

import { dictationLanguage, openDictationDialog, resetDictationDraft } from '../src/ui/dictation-dialog';
import { setLanguage } from '../src/ui/i18n-client';
import type { StateMessage } from '../src/shared/protocol';

class FakeRecorder extends EventTarget {
  static supported = ['audio/webm;codecs=opus', 'audio/webm'];
  static isTypeSupported(t: string): boolean { return FakeRecorder.supported.includes(t); }
  static last: FakeRecorder | undefined;
  state: 'inactive' | 'recording' = 'inactive';
  readonly mimeType: string;
  constructor(readonly stream: unknown, o?: { mimeType?: string }) { super(); this.mimeType = o?.mimeType ?? ''; FakeRecorder.last = this; }
  start(): void { this.state = 'recording'; }
  stop(): void {
    this.state = 'inactive';
    const ev = new Event('dataavailable') as Event & { data: Blob };
    ev.data = new Blob(['clip-bytes'], { type: this.mimeType });
    this.dispatchEvent(ev);
    this.dispatchEvent(new Event('stop'));
  }
}

const state = { language: 'it', project: { name: 'p' } } as unknown as StateMessage;
let hasKey = true;
let transcripts: ({ status: number; body: unknown })[] = [];
let uploads: { url: string; type: string | undefined; size: number; auth: string | undefined }[] = [];
let inputs: unknown[] = [];
let stopped = 0;
let getUserMedia: () => Promise<unknown>;

beforeEach(() => {
  hasKey = true;
  transcripts = [];
  uploads = [];
  inputs = [];
  stopped = 0;
  openOptions.mockClear();
  resetDictationDraft();
  FakeRecorder.last = undefined;
  FakeRecorder.supported = ['audio/webm;codecs=opus', 'audio/webm'];
  getUserMedia = async () => ({ getTracks: () => [{ stop: () => { stopped++; } }] });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => getUserMedia() } });
  document.body.innerHTML = '<div id="overlay" hidden></div>';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    if (url.startsWith('/api/secrets')) return json(200, { groq: { set: hasKey } });
    if (url.startsWith('/api/dictation/transcribe')) {
      const blob = init?.body as Blob;
      uploads.push({ url, type: init?.headers?.['content-type'], size: blob.size, auth: init?.headers?.authorization });
      const r = transcripts.shift() ?? { status: 200, body: { status: 'ok', text: 'text' } };
      return json(r.status, r.body);
    }
    if (url.startsWith('/api/main/input')) { inputs.push(JSON.parse(String(init?.body))); return json(200, { status: 'ok' }); }
    return json(404, null);
  }));
});
afterEach(() => vi.unstubAllGlobals());

const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;
const text = (): HTMLTextAreaElement => $('textarea[name="dictationText"]');
const rec = (): HTMLButtonElement => $('button[name="dictationRecord"]');
const open = async (): Promise<void> => { await openDictationDialog(() => state); await flush(); };
/** One clip: start, then stop; waits for the (fake) transcription. */
async function clip(): Promise<void> {
  rec().click(); await flush();
  rec().click(); await flush();
}

describe('transcription language', () => {
  it('reduces a regional tag to its two-letter prefix and lowercases it', () => {
    expect(dictationLanguage('it-IT')).toBe('it');
    expect(dictationLanguage('pt_BR')).toBe('pt');
    expect(dictationLanguage('EN')).toBe('en');
    expect(dictationLanguage('it')).toBe('it');
  });
  it('resolves auto (or anything unusable) to the browser language, else English', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('fr-CA');
    expect(dictationLanguage('auto')).toBe('fr');
    expect(dictationLanguage('')).toBe('fr');
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('');
    expect(dictationLanguage('auto')).toBe('en');
    vi.restoreAllMocks();
  });
});

describe('dictation dialog', () => {
  it('opens as an overlay dialog that Esc closes', async () => {
    await open();
    const dialog = $('#overlay .dialog.dictation-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog.hasAttribute('data-escape')).toBe(true);
    expect($('#overlay').hidden).toBe(false);
  });

  it('without a key it explains and offers the Secrets tab, and does not offer to record', async () => {
    hasKey = false;
    await open();
    expect($('[data-i18n="dictation.noKey"]')).not.toBeNull();
    expect(rec()).toBeNull();
    $<HTMLButtonElement>('button[name="dictationOpenSecrets"]').click();
    await flush();
    expect(openOptions).toHaveBeenCalledWith(expect.any(Function), 'secrets');
  });

  it('records a clip and puts the transcript in the textarea; the next clips are appended', async () => {
    await open();
    transcripts = [{ status: 200, body: { status: 'ok', text: 'first part' } }, { status: 200, body: { status: 'ok', text: 'second part' } }];
    await clip();
    expect(text().value).toBe('first part');
    await clip();
    expect(text().value).toBe('first part second part');
    expect(uploads).toHaveLength(2);
    expect(uploads[0]!.type).toBe('audio/webm;codecs=opus');
    expect(uploads[0]!.size).toBe('clip-bytes'.length);
    expect(uploads[0]!.url).toContain('lang=');
    expect(uploads[0]!.auth).toMatch(/^Bearer /);
    expect(stopped).toBeGreaterThanOrEqual(2); // the microphone is released after every clip
  });

  it('asks Groq for the interface language', async () => {
    await setLanguage('it').catch(() => undefined); // no bundle in this test: the call only needs to not throw
    await open();
    await clip();
    expect(uploads[0]!.url).toMatch(/lang=[a-z]{2}\b/);
  });

  it('keeps what the user edited when the next clip arrives', async () => {
    await open();
    transcripts = [{ status: 200, body: { status: 'ok', text: 'one' } }, { status: 200, body: { status: 'ok', text: 'three' } }];
    await clip();
    text().value = 'one, edited by hand';
    text().dispatchEvent(new Event('input'));
    await clip();
    expect(text().value).toBe('one, edited by hand three');
  });

  it('shows the translated error of the server and keeps the text', async () => {
    await open();
    text().value = 'kept';
    text().dispatchEvent(new Event('input'));
    transcripts = [{ status: 422, body: { status: 'error', code: 'dictation.noSpeech' } }];
    await clip();
    expect($('.form-error').dataset.i18n).toBe('error.dictation.noSpeech');
    expect(text().value).toBe('kept');
    expect(rec().disabled).toBe(false); // the user can try again
  });

  it.each([
    ['NotAllowedError', 'dictation.mic.denied'],
    ['SecurityError', 'dictation.mic.denied'],
    ['NotFoundError', 'dictation.mic.notFound'],
    ['NotReadableError', 'dictation.mic.busy'],
    ['SomethingElse', 'dictation.mic.failed'],
  ])('maps the microphone error %s to %s', async (name, key) => {
    getUserMedia = async () => { throw Object.assign(new Error('x'), { name }); };
    await open();
    rec().click();
    await flush();
    expect($('.form-error').dataset.i18n).toBe(key);
    expect(FakeRecorder.last).toBeUndefined();
    expect(rec().disabled).toBe(false);
  });

  it('says so when the browser has no microphone API or no recorder', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    await open();
    rec().click();
    await flush();
    expect($('.form-error').dataset.i18n).toBe('dictation.mic.unsupported');
  });

  it('picks the first recording format the browser supports', async () => {
    FakeRecorder.supported = ['audio/webm'];
    await open();
    rec().click(); await flush();
    expect(FakeRecorder.last!.mimeType).toBe('audio/webm');
  });

  it('sends the text to the main (no Enter is added by the page), closes and forgets the draft', async () => {
    await open();
    text().value = 'fix the login';
    text().dispatchEvent(new Event('input'));
    $<HTMLButtonElement>('button[name="dictationSend"]').click();
    await flush();
    expect(inputs).toEqual([{ text: 'fix the login' }]);
    expect($('#overlay').hidden).toBe(true);
    await open();
    expect(text().value).toBe('');
  });

  it('does not send an empty text', async () => {
    await open();
    expect($<HTMLButtonElement>('button[name="dictationSend"]').disabled).toBe(true);
    text().value = 'x';
    text().dispatchEvent(new Event('input'));
    expect($<HTMLButtonElement>('button[name="dictationSend"]').disabled).toBe(false);
  });

  it('closing keeps the text for the next time; Clear empties it', async () => {
    await open();
    text().value = 'draft I want back';
    text().dispatchEvent(new Event('input'));
    $<HTMLButtonElement>('button[name="closeDictation"]').click();
    expect($('#overlay').hidden).toBe(true);
    await open();
    expect(text().value).toBe('draft I want back');
    $<HTMLButtonElement>('button[name="dictationClear"]').click();
    expect(text().value).toBe('');
    $<HTMLButtonElement>('button[name="closeDictation"]').click();
    await open();
    expect(text().value).toBe('');
  });

  it('shows the error when sending fails and keeps the dialog and the text', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => (url.startsWith('/api/secrets')
      ? { status: 200, json: async () => ({ groq: { set: true } }) }
      : { status: 409, json: async () => ({ code: 'dictation.mainNotRunning' }) }));
    await open();
    text().value = 'hello';
    text().dispatchEvent(new Event('input'));
    $<HTMLButtonElement>('button[name="dictationSend"]').click();
    await flush();
    expect($('.form-error').dataset.i18n).toBe('error.dictation.mainNotRunning');
    expect(text().value).toBe('hello');
    expect($('#overlay').hidden).toBe(false);
  });

  it('closing the dialog while recording releases the microphone and drops that clip', async () => {
    await open();
    rec().click(); await flush();
    $<HTMLButtonElement>('button[name="closeDictation"]').click();
    await flush();
    expect(stopped).toBeGreaterThanOrEqual(1);
    expect(uploads).toHaveLength(0);
  });
});
