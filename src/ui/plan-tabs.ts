import type { ApiError, PlanTab } from '../shared/protocol';
import { api } from './api';
import { bindText } from './i18n-client';
import { errorText } from './new-agent';
import { closeOverlay } from './settings';

export interface TabHandlers {
  select(name: string): void;
  close(name: string): void;
  add(): void;
}

/**
 * One tab per open plan (the selected one `current`, a dot class `attention` while that plan's queue is not empty), a small close
 * button after each, then the "+ plan" button. The nodes are replaced on every push: a tab button never needs to keep the keyboard.
 */
export function renderPlanTabs(tabs: HTMLElement, plans: PlanTab[], selected: string, h: TabHandlers): void {
  tabs.replaceChildren();
  for (const p of plans) {
    const tab = document.createElement('button');
    const classes = ['tab'];
    if (p.name === selected) classes.push('current');
    if (p.waiting > 0) classes.push('attention');
    tab.className = classes.join(' ');
    tab.textContent = p.name; // plan name is data, not UI text
    tab.dataset.plan = p.name;
    tab.addEventListener('click', () => h.select(p.name));
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.dataset.plan = p.name;
    bindText(close, 'plans.close');
    close.addEventListener('click', () => h.close(p.name));
    tabs.append(tab, close);
  }
  const add = document.createElement('button');
  add.className = 'tab';
  bindText(add, 'tabs.newPlan');
  add.addEventListener('click', () => h.add());
  tabs.append(add);
}

/** The page title with a `(n) ` prefix while questions wait in any plan (n is the total over all plans). */
export function titleWithWaiting(base: string, plans: PlanTab[]): string {
  const total = plans.reduce((n, p) => n + p.waiting, 0);
  return total > 0 ? `(${total}) ${base}` : base;
}

/** The plan next to `selected` in the given direction, wrapping around; undefined when there is nowhere to go. */
export function neighbourPlan(plans: PlanTab[], selected: string, direction: 1 | -1): string | undefined {
  if (plans.length < 2) return undefined;
  const i = plans.findIndex((p) => p.name === selected);
  return plans[(Math.max(i, 0) + direction + plans.length) % plans.length]!.name;
}

/** Asks before closing a plan (its running sessions end; nothing is deleted on disk). */
export function openClosePlanDialog(name: string): void {
  const overlay = document.getElementById('overlay')!;
  const dialog = document.createElement('div');
  dialog.className = 'dialog';
  dialog.dataset.escape = '';
  const message = document.createElement('div');
  bindText(message, 'plans.close.confirm', { name });
  const error = document.createElement('div');
  error.className = 'form-error';
  const actions = document.createElement('div');
  actions.className = 'form-actions';
  const yes = document.createElement('button');
  bindText(yes, 'plans.close.do');
  yes.addEventListener('click', () => {
    void api<ApiError | { name: string }>(`/api/plans/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((res) => {
      if (res.status === 200) closeOverlay();
      else error.textContent = errorText(res.body as ApiError);
    });
  });
  const cancel = document.createElement('button');
  bindText(cancel, 'common.cancel');
  cancel.addEventListener('click', closeOverlay);
  actions.append(yes, cancel);
  dialog.append(message, error, actions);
  overlay.replaceChildren(dialog);
  overlay.hidden = false;
}
