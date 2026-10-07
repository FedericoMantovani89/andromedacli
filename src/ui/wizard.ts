import type { StateMessage } from '../shared/protocol';
import { api } from './api';
import { bindText, k } from './i18n-client';
import { closeOverlay, createLanguageSelect, renderPrereqTable } from './settings';
import { openNewProjectDialog } from './new-project';

type Step = 'language' | 'prerequisites' | 'project';
const STEPS: Step[] = ['language', 'prerequisites', 'project'];
const STEP_TITLES: Record<Step, string> = {
  language: k('wizard.step.language'),
  prerequisites: k('wizard.step.prerequisites'),
  project: k('wizard.step.project'),
};

/**
 * First-start wizard (SPEC 29.2, the Phase 1 steps). Every step can be skipped, and every way out saves a
 * configuration file, so the wizard never loops. Nothing here blocks the console.
 */
export function openWizard(getState: () => StateMessage | undefined): void {
  const overlay = document.getElementById('overlay')!;
  let chosenLanguage = getState()?.language ?? 'auto';
  let index = 0;

  const finish = () => {
    return api('/api/config', { method: 'PUT', body: { language: chosenLanguage } }).then(closeOverlay);
  };

  const render = () => {
    const state = getState();
    const step = STEPS[index]!;
    const dialog = document.createElement('div');
    dialog.className = 'dialog';

    const title = document.createElement('h2');
    bindText(title, 'wizard.title');
    const sub = document.createElement('h2');
    bindText(sub, STEP_TITLES[step]);
    const body = document.createElement('div');

    if (step === 'language') {
      body.append(createLanguageSelect(chosenLanguage, state?.languages ?? [], (v) => { chosenLanguage = v; }));
    } else if (step === 'prerequisites') {
      renderPrereqTable(body, state?.prereq ?? null);
    } else {
      const folder = document.createElement('div');
      const folderLabel = document.createElement('span');
      bindText(folderLabel, 'wizard.project.folder');
      const folderValue = document.createElement('code');
      folderValue.textContent = ` ${state?.projectRoot ?? ''}`;
      folder.append(folderLabel, folderValue);
      body.append(folder);
      if (state && !state.projectIsRepo) {
        const warn = document.createElement('div');
        warn.className = 'form-error';
        bindText(warn, 'wizard.project.notRepo');
        body.append(warn);
      }
    }

    const actions = document.createElement('div');
    actions.className = 'form-actions';
    const last = index === STEPS.length - 1;
    const next = document.createElement('button');
    bindText(next, last ? k('wizard.finish') : k('common.next'));
    next.addEventListener('click', () => { if (last) void finish(); else { index += 1; render(); } });
    const skip = document.createElement('button');
    bindText(skip, 'common.skip');
    skip.addEventListener('click', () => { if (last) void finish(); else { index += 1; render(); } });
    actions.append(next, skip);
    if (last) {
      // SPEC 29.2 step 6: the user may open another project (the dialog asks only for its folder). The wizard is finished first (the configuration is saved).
      const fromTemplate = document.createElement('button');
      bindText(fromTemplate, 'wizard.project.newProject');
      fromTemplate.addEventListener('click', () => { void finish().then(() => openNewProjectDialog(getState)); });
      actions.append(fromTemplate);
    }

    dialog.append(title, sub, body, actions);
    overlay.replaceChildren(dialog);
    overlay.hidden = false;
  };
  render();
}
