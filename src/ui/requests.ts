import type { RequestRow } from '../shared/requests';
import { keepFocus, reconcile } from './dom';
import { createDrawerShell } from './drawer';
import { bindText, k } from './i18n-client';

const STATE_KEYS: Record<RequestRow['state'], string> = {
  open: k('requests.state.open'),
  escalated: k('requests.state.escalated'),
  answered: k('requests.state.answered'),
  cancelled: k('requests.state.cancelled'),
};
const REASON_KEYS: Record<NonNullable<RequestRow['escalatedBy']>, string> = {
  timeout: k('requests.reason.timeout'),
  unknown: k('requests.reason.unknown'),
  recipient_gone: k('requests.reason.recipient_gone'),
  explicit: k('requests.reason.explicit'),
};

interface Entry { el: HTMLElement; set(r: RequestRow): void }

function createEntry(): Entry {
  const el = document.createElement('div');
  el.className = 'queue-item request-item';
  const head = document.createElement('div');
  head.className = 'queue-from request-head';
  const state = document.createElement('span');
  const text = document.createElement('div');
  text.className = 'queue-text request-text';
  const meta = document.createElement('div');
  meta.className = 'queue-from request-meta';
  el.append(head, state, text, meta);
  return {
    el,
    set(r) {
      el.dataset.id = r.id;
      bindText(head, k('requests.item'), { id: r.id, from: r.from, to: r.to });
      bindText(state, STATE_KEYS[r.state]);
      state.className = `request-state ${r.state}`;
      text.textContent = r.text; // the question is data, never markup
      if (r.state === 'escalated' && r.escalatedBy) bindText(meta, REASON_KEYS[r.escalatedBy], { handler: r.handler });
      else if (r.state === 'open' && r.deadline) bindText(meta, k('requests.deadline'), { handler: r.handler, time: new Date(r.deadline).toLocaleTimeString() });
      else if (r.state === 'open') bindText(meta, k('requests.with'), { handler: r.handler });
      else { meta.textContent = ''; delete meta.dataset.i18n; delete meta.dataset.i18nParams; }
    },
  };
}

/** The read-only list of the requests between agents (SPEC 10): the user talks to the main, never writes a request. */
export function createRequestsDrawer(root: HTMLElement) {
  const { list, empty, ...shell } = createDrawerShell(root, k('requests.title'), k('requests.empty'));
  const entries = new Map<string, Entry>();

  return {
    ...shell,
    update(rows: RequestRow[]): void {
      const ids = new Set(rows.map((r) => r.id));
      for (const id of [...entries.keys()]) if (!ids.has(id)) entries.delete(id);
      for (const r of rows) {
        let e = entries.get(r.id);
        if (!e) { e = createEntry(); entries.set(r.id, e); }
        e.set(r);
      }
      reconcile(list, rows.map((r) => entries.get(r.id)!.el));
      empty.hidden = rows.length > 0;
    },
  };
}
