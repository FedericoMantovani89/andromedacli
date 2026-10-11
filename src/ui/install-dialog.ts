import type { ApiError } from '../shared/protocol';
import { api } from './api';
import { checkbox } from './dom';
import { bindText, k, t } from './i18n-client';
import { errorText } from './new-agent';
import { openInstallTerminal } from './install-terminal';

interface InstallInfo {
  id: string; action: 'install' | 'update'; display: string; source: { kind: string; origin: string };
  secondConfirm: boolean; mayNeedAdmin: boolean; verified: boolean;
}
type Described = InstallInfo | { unavailable: string };

const TITLE_KEYS = { install: k('prereq.install.title.install'), update: k('prereq.install.title.update') } as const;
const UNAVAILABLE_KEYS: Record<string, string> = {
  unsupported_platform: k('prereq.install.unavailable.unsupported_platform'),
  no_winget: k('prereq.install.unavailable.no_winget'),
  no_npm: k('prereq.install.unavailable.no_npm'),
};
const MANUAL_KEYS: Record<string, string> = {
  node: k('prereq.install.manual.node'), git: k('prereq.install.manual.git'),
  claude: k('prereq.install.manual.claude'), gh: k('prereq.install.manual.gh'),
};

/**
 * The consent dialog of an assisted install: the exact command, where it comes from and what it may do. Consent is the click on
 * "Run it"; nothing runs before. The dialog takes the overlay for a while and gives the previous content back when it is done,
 * so the Options tab or the wizard step is still there. `onDone` runs then (the table checks again).
 */
export function openInstallDialog(id: string, onDone: () => void): void {
  const overlay = document.getElementById('overlay')!;
  const previous = [...overlay.childNodes];
  const restore = () => { overlay.replaceChildren(...previous); onDone(); };

  void api<Described | ApiError>(`/api/prereq/${id}/install`).then((res) => {
    const dialog = document.createElement('div');
    dialog.className = 'dialog install-dialog';
    const title = document.createElement('h2');
    const toolName = t('prereq.' + id);
    const actions = document.createElement('div');
    actions.className = 'form-actions';
    const cancel = document.createElement('button');
    bindText(cancel, 'common.cancel');
    cancel.addEventListener('click', restore);

    const body = res.body as Described;
    if (res.status !== 200 || !('display' in body)) {
      // Not installable from here: the manual instructions instead (no command is offered).
      bindText(title, TITLE_KEYS.install, { tool: toolName });
      const why = document.createElement('p');
      const reason = res.status === 200 && 'unavailable' in body ? body.unavailable : '';
      if (UNAVAILABLE_KEYS[reason]) bindText(why, UNAVAILABLE_KEYS[reason]!);
      else why.textContent = errorText(res.body as ApiError);
      const manual = document.createElement('p');
      if (MANUAL_KEYS[id]) bindText(manual, MANUAL_KEYS[id]!);
      dialog.append(title, why, manual, actions);
      actions.append(cancel);
      bindText(cancel, 'common.close');
    } else {
      bindText(title, TITLE_KEYS[body.action], { tool: toolName });
      const intro = document.createElement('p');
      bindText(intro, 'prereq.install.command');
      const code = document.createElement('pre');
      code.className = 'install-command';
      code.textContent = body.display;
      const source = document.createElement('p');
      bindText(source, 'prereq.install.source', { origin: body.source.origin });
      dialog.append(title, intro, code, source);
      if (body.mayNeedAdmin) {
        const admin = document.createElement('p');
        admin.className = 'settings-note';
        bindText(admin, 'prereq.install.admin');
        dialog.append(admin);
      }
      if (!body.verified) {
        const unverified = document.createElement('p');
        unverified.className = 'settings-note';
        bindText(unverified, 'prereq.install.unverified');
        dialog.append(unverified);
      }
      const confirm = document.createElement('button');
      bindText(confirm, 'prereq.install.confirm');
      let script: HTMLInputElement | undefined;
      if (body.secondConfirm) {
        const scriptBox = checkbox(undefined, 'prereq.install.script');
        script = scriptBox.input;
        dialog.append(scriptBox.row);
        confirm.disabled = true;
        script.addEventListener('change', () => { confirm.disabled = !script!.checked; });
      }
      const error = document.createElement('div');
      error.className = 'form-error';
      confirm.addEventListener('click', () => {
        confirm.disabled = true;
        void api<{ terminal: string } | ApiError>(`/api/prereq/${id}/install`, {
          method: 'POST', body: { confirmed: true, ...(script ? { confirmedScript: script.checked } : {}) },
        }).then((r) => {
          if (r.status === 202) { openInstallTerminal((r.body as { terminal: string }).terminal, restore); return; }
          error.textContent = errorText(r.body as ApiError);
          confirm.disabled = false;
        });
      });
      actions.append(confirm, cancel);
      dialog.append(error, actions);
    }
    overlay.replaceChildren(dialog);
    overlay.hidden = false;
  });
}
