import type { ApiError, StateMessage } from '../shared/protocol';
import { api, token } from './api';
import { el } from './dom';
import { focusElementFromUser } from './focus';
import { bindText, k, language, t } from './i18n-client';
import { closeOverlay } from './settings';

/**
 * Voice dictation for the main: record a clip with the browser's microphone, have the console transcribe it (the server calls Groq, so the
 * key never reaches the page), edit the text, record more (each transcript is appended) and type the result into the main's input
 * WITHOUT pressing Enter. Closing the dialog keeps the text until the page is reloaded, Clear is pressed or the text is sent.
 */

/** The text being written; module-level so closing and reopening the dialog does not lose it. */
let draft = '';
export function resetDictationDraft(): void { draft = ''; }

/** Formats the browser recorder may support, best first (Chrome and Edge: webm/opus; Safari: mp4). */
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
const pickMimeType = (): string => (typeof MediaRecorder === 'undefined' ? '' : MIME_TYPES.find((m) => MediaRecorder.isTypeSupported(m)) ?? '');

/** The language Whisper is asked for: the UI language as a plain two-letter code ("it-IT" -> "it"; "auto" or anything unusable -> the browser's, else English). */
export function dictationLanguage(ui: string): string {
  const code = (tag: string): string | undefined => { const c = tag.toLowerCase().split(/[-_]/)[0] ?? ''; return /^[a-z]{2,3}$/.test(c) && c !== 'aut' ? c : undefined; };
  return code(ui === 'auto' ? '' : ui) ?? code(navigator.language || '') ?? 'en';
}

/** Why the microphone could not be opened, as a text key. */
function micErrorKey(e: unknown): string {
  switch ((e as { name?: string } | null)?.name) {
    case 'NotAllowedError': case 'SecurityError': return k('dictation.mic.denied');
    case 'NotFoundError': case 'OverconstrainedError': return k('dictation.mic.notFound');
    case 'NotReadableError': case 'AbortError': return k('dictation.mic.busy');
    default: return k('dictation.mic.failed');
  }
}

/** An answer of the console that is an error, as a text key (only the dictation codes have a text of their own). */
const errorKeyOf = (body: unknown): string => {
  const code = (body as Partial<ApiError> | null)?.code;
  return typeof code === 'string' && code.startsWith('dictation.') ? `error.${code}` : k('error.generic');
};

export async function openDictationDialog(getState: () => StateMessage | undefined): Promise<void> {
  const overlay = document.getElementById('overlay')!;
  const dialog = el('div', 'dialog dictation-dialog');
  dialog.dataset.escape = '';
  const title = el('h2');
  bindText(title, 'dictation.title');
  const body = el('div', 'dictation-body');
  const error = el('div', 'form-error');
  const close = el('button');
  close.type = 'button';
  close.name = 'closeDictation';
  bindText(close, 'common.close');
  close.addEventListener('click', closeOverlay);
  const actions = el('div', 'form-actions');
  dialog.append(title, body, error, actions);
  overlay.replaceChildren(dialog);
  overlay.hidden = false;

  const showError = (key: string): void => bindText(error, key);
  const clearError = (): void => { error.textContent = ''; delete error.dataset.i18n; };

  const have = await api<{ groq?: { set?: boolean } }>('/api/secrets').catch(() => ({ status: 0, body: null }));
  if (!dialog.isConnected) return; // closed while asking
  if (!(have.status === 200 && have.body?.groq?.set)) {
    const why = el('p', 'settings-note');
    bindText(why, 'dictation.noKey');
    body.append(why);
    const open = el('button');
    open.type = 'button';
    open.name = 'dictationOpenSecrets';
    bindText(open, 'dictation.openSecrets');
    open.addEventListener('click', () => { void import('./options').then((m) => m.openOptions(getState, 'secrets')); });
    actions.append(close, open);
    return;
  }

  const label = el('label');
  const labelText = el('span');
  bindText(labelText, 'dictation.textLabel');
  const text = el('textarea');
  text.name = 'dictationText';
  text.rows = 8;
  text.dataset.i18nPlaceholder = k('dictation.placeholder');
  text.placeholder = t('dictation.placeholder');
  text.value = draft;
  label.append(labelText, text);
  const status = el('p', 'settings-note dictation-status');
  status.setAttribute('role', 'status');
  const note = el('p', 'settings-note');
  bindText(note, 'dictation.sendNote');
  body.append(label, status, note);

  const record = el('button');
  record.type = 'button';
  record.name = 'dictationRecord';
  bindText(record, 'dictation.record');
  const clear = el('button');
  clear.type = 'button';
  clear.name = 'dictationClear';
  bindText(clear, 'dictation.clear');
  const send = el('button');
  send.type = 'button';
  send.name = 'dictationSend';
  bindText(send, 'dictation.send');
  actions.append(send, record, clear, close);

  type Phase = 'idle' | 'opening' | 'recording' | 'transcribing' | 'sending';
  let phase: Phase = 'idle';
  const render = (): void => {
    record.disabled = phase === 'opening' || phase === 'transcribing' || phase === 'sending';
    bindText(record, phase === 'recording' ? k('dictation.stop') : k('dictation.record'));
    clear.disabled = phase === 'recording' || phase === 'transcribing' || phase === 'sending';
    send.disabled = phase !== 'idle' || text.value.trim() === '';
    if (phase === 'recording') bindText(status, 'dictation.recording');
    else if (phase === 'transcribing') bindText(status, 'dictation.transcribing');
    else { status.textContent = ''; delete status.dataset.i18n; }
  };
  const setPhase = (p: Phase): void => { phase = p; render(); };
  text.addEventListener('input', () => { draft = text.value; render(); });
  clear.addEventListener('click', () => { text.value = ''; draft = ''; clearError(); render(); });

  let recorder: MediaRecorder | undefined;
  let stream: MediaStream | undefined;
  let discard = false;
  const releaseMic = (): void => { for (const t of stream?.getTracks() ?? []) t.stop(); stream = undefined; };

  /** The user left the dialog (Esc, X, another dialog): a clip in progress is dropped and the microphone is released. */
  const watcher = new MutationObserver(() => {
    if (dialog.isConnected) return;
    watcher.disconnect();
    discard = true;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    releaseMic();
  });
  watcher.observe(overlay, { childList: true });

  const append = (heard: string): void => {
    const before = text.value.trimEnd();
    text.value = before === '' ? heard : `${before} ${heard}`;
    draft = text.value;
  };

  const upload = async (clip: Blob): Promise<void> => {
    setPhase('transcribing');
    try {
      const res = await fetch(`/api/dictation/transcribe?lang=${encodeURIComponent(dictationLanguage(language()))}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': clip.type || 'audio/webm' }, body: clip,
      });
      const answer = (await res.json().catch(() => null)) as { status?: string; text?: string } | null;
      if (res.status === 200 && answer?.status === 'ok' && typeof answer.text === 'string') append(answer.text);
      else showError(errorKeyOf(answer));
    } catch {
      showError(k('error.dictation.network'));
    }
    setPhase('idle');
  };

  const start = async (): Promise<void> => {
    clearError();
    const devices = navigator.mediaDevices as MediaDevices | undefined;
    if (!devices?.getUserMedia || typeof MediaRecorder === 'undefined') { showError(k('dictation.mic.unsupported')); return; }
    setPhase('opening');
    let opened: MediaStream;
    try {
      opened = await devices.getUserMedia({ audio: true });
    } catch (e) {
      showError(micErrorKey(e));
      setPhase('idle');
      return;
    }
    stream = opened;
    if (!dialog.isConnected) { releaseMic(); return; }
    try {
      const mimeType = pickMimeType();
      const chunks: Blob[] = [];
      const next = new MediaRecorder(opened, mimeType ? { mimeType } : undefined);
      recorder = next;
      discard = false;
      next.addEventListener('dataavailable', (ev) => { const data = (ev as BlobEvent).data; if (data && data.size > 0) chunks.push(data); });
      next.addEventListener('stop', () => {
        releaseMic();
        recorder = undefined;
        if (discard || !dialog.isConnected) return;
        const clip = new Blob(chunks, { type: next.mimeType || mimeType });
        if (clip.size === 0) { showError(k('error.dictation.emptyAudio')); setPhase('idle'); return; }
        void upload(clip);
      });
      next.start();
      setPhase('recording');
    } catch {
      releaseMic();
      showError(k('dictation.mic.failed'));
      setPhase('idle');
    }
  };

  record.addEventListener('click', () => {
    if (phase === 'recording') { recorder?.stop(); return; }
    if (phase === 'idle') void start();
  });

  send.addEventListener('click', () => {
    clearError();
    setPhase('sending');
    void api<ApiError>('/api/main/input', { method: 'POST', body: { text: text.value } }).then((res) => {
      if (res.status === 200) { resetDictationDraft(); closeOverlay(); return; }
      showError(errorKeyOf(res.body));
      setPhase('idle');
    }, () => { showError(k('error.generic')); setPhase('idle'); });
  });

  render();
  focusElementFromUser(text, 'user'); // opened by a click on the header button
}
