import type { ApiError } from '../shared/protocol';
import { api } from './api';
import { el } from './dom';
import { infoIcon } from './info-icon';
import { bindText, k } from './i18n-client';

type Stage = (key: string, run: (dry: boolean) => Promise<{ status: number; body: unknown }>) => void;

/**
 * The Secrets tab: console-wide keys. Today only the Groq key of the voice dictation. The page never receives the key: it learns only
 * whether one is saved, and a typed key (or a removal) is staged for the dialog's single Save (PUT /api/secrets, checked first with ?dryRun=1).
 */
export function renderSecretsTab(container: HTMLElement, stage: Stage): void {
  const box = el('div', 'settings-agents');
  const warning = el('p', 'settings-note');
  bindText(warning, 'options.secrets.groqWarning'); // said before the key is typed, not after
  box.append(warning);

  const field = el('label', 'options-field');
  const label = el('span');
  bindText(label, 'options.secrets.groqLabel');
  const input = el('input');
  input.type = 'password';
  input.name = 'secrets.groqKey';
  input.autocomplete = 'off';
  input.spellcheck = false;
  const head = el('span', 'options-field-head');
  head.append(label, infoIcon(k('options.secrets.groqTip')));
  field.append(head, input);
  box.append(field);

  const row = el('div', 'options-secret-status');
  const rowLabel = el('span');
  bindText(rowLabel, 'options.secrets.status');
  const state = el('span', 'secret-state');
  state.dataset.secretStatus = 'groq';
  row.append(rowLabel, state);
  box.append(row);

  let saved: boolean | undefined; // unknown until the console answers
  let clearing = false;
  let clearBtn: HTMLButtonElement | undefined;
  const paint = (): void => {
    state.classList.toggle('willclear', clearing);
    bindText(state, clearing ? k('options.secrets.willClear') : saved ? k('options.secrets.set') : k('common.notAvailable'));
    if (saved && !clearBtn) {
      clearBtn = el('button');
      clearBtn.type = 'button';
      clearBtn.name = 'clearGroqKey';
      clearBtn.addEventListener('click', () => { clearing = !clearing; if (clearing) input.value = ''; paint(); });
      row.append(clearBtn);
    }
    if (clearBtn) bindText(clearBtn, clearing ? k('options.secrets.undoClear') : k('options.secrets.clear'));
  };
  input.addEventListener('input', () => { if (input.value !== '') clearing = false; paint(); });
  paint();

  // One staged entry; what it sends is decided at Save time. Nothing typed and nothing to remove: nothing is sent.
  stage('secrets:groq', async (dry) => {
    const typed = input.value.trim();
    if (typed === '' && !clearing) return { status: 200, body: {} };
    return api<ApiError>(dry ? '/api/secrets?dryRun=1' : '/api/secrets', { method: 'PUT', body: { groqKey: clearing ? null : typed } });
  });

  void api<{ groq?: { set?: boolean } }>('/api/secrets').then((res) => {
    saved = res.status === 200 && res.body?.groq?.set === true;
    paint();
  }, () => undefined);

  container.replaceChildren(box);
}
