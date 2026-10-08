import type { ApiError, StateMessage } from '../shared/protocol';
import { api } from './api';
import { renderGitProject } from './git-section';
import { bindText, k } from './i18n-client';
import { errorText } from './new-agent';
import { closeOverlay, createLanguageSelect, renderPrereqTable } from './settings';

type Step = 'language' | 'prerequisites' | 'git';
const STEP_TITLES: Record<Step, string> = {
  language: k('wizard.step.language'),
  prerequisites: k('wizard.step.prerequisites'),
  git: k('wizard.step.git'),
};

/**
 * First-start wizard (SPEC 29.2): the language, the prerequisites and, only when the chosen project folder is not a git repository,
 * an optional step that offers `git init`. The steps are fixed when it opens. Back, the recheck button and Next share one row; the
 * last Next ends it and saves the configuration, so the wizard never loops. Nothing here blocks the console.
 */
export function openWizard(getState: () => StateMessage | undefined): void {
  const overlay = document.getElementById('overlay')!;
  const offered = getState()?.languages ?? [];
  const saved = getState()?.language ?? 'en';
  let chosenLanguage = offered.includes(saved) ? saved : 'en'; // an older "auto" is English now
  const first = getState();
  const steps: Step[] = ['language', 'prerequisites', ...(first && !first.projectIsRepo ? ['git' as const] : [])];
  let index = 0;

  const finish = () => {
    return api('/api/config', { method: 'PUT', body: { language: chosenLanguage } }).then(closeOverlay);
  };

  const render = () => {
    const state = getState();
    const step = steps[index]!;
    const dialog = document.createElement('div');
    dialog.className = 'dialog';

    // One heading: the step is the title, "First start · step n of m" a quiet line above it.
    const head = document.createElement('header');
    head.className = 'wizard-head';
    const progress = document.createElement('div');
    progress.className = 'wizard-eyebrow';
    bindText(progress, 'wizard.progress', { n: index + 1, total: steps.length });
    const title = document.createElement('h2');
    bindText(title, STEP_TITLES[step]);
    head.append(progress, title);

    const body = document.createElement('div');
    body.className = 'wizard-body';
    const error = document.createElement('div');
    error.className = 'form-error';
    const actions = document.createElement('div');
    actions.className = 'form-actions wizard-actions';
    const left = document.createElement('div');
    const middle = document.createElement('div');
    const right = document.createElement('div');

    if (step === 'language') {
      body.append(createLanguageSelect(chosenLanguage, state?.languages ?? [], (v) => { chosenLanguage = v; }));
    } else if (step === 'prerequisites') {
      renderPrereqTable(body, state?.prereq ?? null, middle, true); // required tools only: the optional ones are in Options
    } else {
      body.append(renderGitProject(state, (res) => {
        if (res.status >= 200 && res.status < 300) return false;
        error.textContent = errorText(res.body as ApiError);
        return true;
      }));
      const later = document.createElement('p');
      later.className = 'settings-note';
      bindText(later, 'wizard.git.later');
      body.append(later);
    }

    const last = index === steps.length - 1;
    if (index > 0) {
      const back = document.createElement('button');
      back.className = 'wizard-back';
      bindText(back, 'common.back');
      back.addEventListener('click', () => { index -= 1; render(); });
      left.append(back);
    }
    const next = document.createElement('button');
    next.className = 'wizard-next';
    bindText(next, last ? k('wizard.finish') : k('common.next'));
    next.addEventListener('click', () => { if (last) void finish(); else { index += 1; render(); } });
    right.append(next);
    actions.append(left, middle, right);

    dialog.append(head, body, error, actions);
    overlay.replaceChildren(dialog);
    overlay.hidden = false;
  };
  render();
}
