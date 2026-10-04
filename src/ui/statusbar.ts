import type { StateMessage } from '../shared/protocol';
import { runningAgents } from '../shared/stats';
import { bindText, k } from './i18n-client';

function item(label: string, valueEl: HTMLElement): HTMLElement {
  const wrap = document.createElement('span');
  const l = document.createElement('span');
  bindText(l, label);
  const sep = document.createElement('span');
  sep.textContent = ' ';
  wrap.append(l, sep, valueEl);
  return wrap;
}

const na = (): HTMLElement => {
  const v = document.createElement('span');
  bindText(v, 'common.notAvailable'); // no data source yet: "n/a", never a zero (P7)
  return v;
};

/** Bottom bar (SPEC 5.7). Budget and quotas have no source in Phase 1, so they show n/a. */
export function renderStatusBar(el: HTMLElement, state: StateMessage): void {
  el.replaceChildren();
  const running = runningAgents(state.main, state.agents);
  const agents = document.createElement('span');
  bindText(agents, 'statusbar.agents', { count: running });
  const suspended = document.createElement('span');
  // Nothing can be suspended in Phase 1, so 0 is real data here, not a missing value.
  bindText(suspended, 'statusbar.suspended', { count: 0 });
  el.append(
    item(k('statusbar.budget'), na()),
    item(k('statusbar.quota5h'), na()),
    item(k('statusbar.quotaWeek'), na()),
    agents,
    suspended,
  );
}
