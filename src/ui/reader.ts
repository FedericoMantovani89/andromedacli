import { api } from './api';
import { bindText, k, setPlaceholder } from './i18n-client';
import { renderInto } from './markdown-lazy';

export interface ReadingEntry { n: number; at: string; text: string; truncated?: true }

/**
 * The "read" panel (SPEC 5.5): the last answers of one agent as rendered Markdown, with ordinary browser scrolling,
 * a filter, and a copy button. The text never travels through the terminal.
 */
export function createReader(root: HTMLElement) {
  const head = document.createElement('div');
  head.className = 'drawer-head';
  const title = document.createElement('h2');
  const search = document.createElement('input');
  setPlaceholder(search, 'reader.search');
  const copy = document.createElement('button');
  bindText(copy, 'reader.copy');
  const close = document.createElement('button');
  bindText(close, 'common.close');
  head.append(title, search, copy, close);

  const body = document.createElement('div');
  body.className = 'reader-body';
  const turns = document.createElement('div');
  turns.className = 'reader-turns';
  const content = document.createElement('div');
  content.className = 'reader-content';
  const empty = document.createElement('div');
  empty.className = 'queue-empty';
  bindText(empty, 'reader.empty');
  const note = document.createElement('div');
  note.className = 'form-error';
  note.hidden = true;
  bindText(note, 'reader.truncated');
  body.append(turns, content);
  root.append(head, empty, body);

  let slug: string | undefined;
  let entries: ReadingEntry[] = [];
  let selected: number | undefined;
  let isOpen = false;
  const setOpen = (v: boolean) => { isOpen = v; root.hidden = !v; };
  setOpen(false);

  const show = (n: number | undefined) => {
    selected = n;
    const e = entries.find((x) => x.n === n);
    content.replaceChildren();
    if (!e) return;
    const html = document.createElement('div');
    html.className = 'markdown';
    renderInto(html, e.text); // sanitised when formatted: answers are untrusted text
    content.append(...(e.truncated ? [note] : []), html);
    note.hidden = !e.truncated;
    for (const b of turns.querySelectorAll<HTMLElement>('button')) b.classList.toggle('selected', Number(b.dataset.n) === n);
  };

  const renderList = () => {
    const q = search.value.trim().toLowerCase();
    turns.replaceChildren();
    for (const e of [...entries].reverse()) {
      if (q && !e.text.toLowerCase().includes(q)) continue;
      const b = document.createElement('button');
      b.dataset.n = String(e.n);
      bindText(b, k('reader.turn'), { n: e.n });
      const time = document.createElement('small');
      time.textContent = new Date(e.at).toLocaleTimeString();
      b.append(' ', time);
      b.addEventListener('click', () => show(e.n));
      turns.append(b);
    }
    empty.hidden = entries.length > 0;
    body.hidden = entries.length === 0;
    for (const b of turns.querySelectorAll<HTMLElement>('button')) b.classList.toggle('selected', Number(b.dataset.n) === selected);
  };

  search.addEventListener('input', renderList);
  close.addEventListener('click', () => setOpen(false));
  copy.addEventListener('click', () => {
    const e = entries.find((x) => x.n === selected);
    if (!e) return;
    void navigator.clipboard.writeText(e.text).then(() => {
      bindText(copy, 'reader.copied');
      setTimeout(() => bindText(copy, 'reader.copy'), 1500);
    }).catch(() => { /* clipboard blocked: nothing to do */ });
  });

  return {
    isOpen: () => isOpen,
    current: () => slug,
    /** Opens (or closes, if already showing this agent) the panel for `name`. */
    async toggle(name: string): Promise<void> {
      if (isOpen && slug === name) { setOpen(false); return; }
      slug = name;
      bindText(title, 'reader.title', { slug: name });
      const res = await api<{ entries: ReadingEntry[] }>(`/api/reading/${name}`);
      entries = res.status === 200 ? res.body.entries : [];
      search.value = '';
      renderList();
      show(entries.at(-1)?.n);
      setOpen(true);
    },
    /** A live answer arrived: follow it only if the user was looking at the latest one (never yank the view). */
    onEntry(name: string, entry: ReadingEntry): void {
      if (name !== slug) return;
      const followLatest = selected === undefined || selected === entries.at(-1)?.n;
      entries.push(entry);
      renderList();
      if (followLatest) show(entry.n);
    },
  };
}
