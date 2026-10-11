import { setTitle } from './i18n-client';
import { el } from './dom';

/** The (i) icon whose tooltip explains an option in detail (the text is a key, with optional parameters; it follows the language). */
export const infoIcon = (key: string, params?: Record<string, string | number>): HTMLElement => {
  const icon = el('span', 'info-icon');
  setTitle(icon, key, params); // the class is set first: the tooltip is drawn by CSS, narrow and tall
  icon.tabIndex = 0;
  return icon;
};
