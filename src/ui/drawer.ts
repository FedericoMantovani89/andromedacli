import { keepFocus } from './dom';
import { bindText } from './i18n-client';

/**
 * The shell shared by the side drawers (the question queue, the requests between agents): a header with the title and a close button, a
 * list, and the "nothing here" line. The caller fills `list` (keeping its nodes stable) and shows `empty` when there is nothing to list.
 */
export function createDrawerShell(root: HTMLElement, titleKey: string, emptyKey: string) {
  const title = document.createElement('h2');
  bindText(title, titleKey);
  const close = document.createElement('button');
  bindText(close, 'common.close');
  keepFocus(close);
  const head = document.createElement('div');
  head.className = 'drawer-head';
  head.append(title, close);
  const list = document.createElement('div');
  list.className = 'queue-list';
  const empty = document.createElement('div');
  empty.className = 'queue-empty';
  bindText(empty, emptyKey);
  root.append(head, list, empty);

  let open = false;
  const setOpen = (value: boolean): void => { open = value; root.hidden = !value; };
  close.addEventListener('click', () => setOpen(false));
  setOpen(false);

  return {
    list,
    empty,
    setOpen,
    isOpen: (): boolean => open,
    toggle: (): void => setOpen(!open),
    close: (): void => setOpen(false),
  };
}
