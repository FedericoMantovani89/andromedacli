import { setTitle } from './i18n-client';

export type IconName = 'bell' | 'gear' | 'clipboard' | 'mic' | 'record' | 'stop';

const NS = 'http://www.w3.org/2000/svg';

/** Stroke paths on a 24x24 grid; the color is the button's own (currentColor). */
const PATHS: Record<IconName, string[]> = {
  bell: ['M6 9a6 6 0 0 1 12 0c0 6 2 7.5 2 7.5H4S6 15 6 9z', 'M10 20a2 2 0 0 0 4 0'],
  gear: [
    'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
    'M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1',
  ],
  mic: ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M5.5 11a6.5 6.5 0 0 0 13 0', 'M12 17.5V21'],
  // Filled shapes (see svgFor): the red dot of a recorder and its red stop square.
  record: ['M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z'],
  stop: ['M6.5 6.5h11v11h-11z'],
  clipboard: ['M9 4h6v3H9z', 'M15 5.5h2.5a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19V7a1.5 1.5 0 0 1 1.5-1.5H9', 'M8.5 11h7M8.5 14.5h7M8.5 18h4'],
};

function svgFor(name: IconName): SVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  const filled = name === 'record' || name === 'stop';
  svg.setAttribute('fill', filled ? 'currentColor' : 'none');
  svg.setAttribute('stroke', filled ? 'none' : 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.dataset.icon = name;
  for (const d of PATHS[name]) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

/** Turns a button into an icon button: the icon replaces the text, the tooltip and accessible name come from the key (and follow the language). The button itself is never replaced, so it keeps focus. */
export function setIconButton(btn: HTMLElement, name: IconName, titleKey: string, params?: Record<string, string | number>): void {
  const current = btn.querySelector<SVGElement>(':scope > svg.icon');
  if (current?.dataset.icon !== name) {
    for (const node of [...btn.childNodes]) if (node.nodeType === Node.TEXT_NODE || node === current) node.remove();
    btn.prepend(svgFor(name));
  }
  btn.classList.add('icon-action');
  setTitle(btn, titleKey, params);
}

/** The pending count over the bell: hidden at zero (the tooltip still says the number). */
export function setQueueBadge(btn: HTMLElement, count: number): void {
  let badge = btn.querySelector<HTMLElement>(':scope > .icon-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'icon-badge';
    btn.append(badge);
  }
  badge.textContent = String(count);
  badge.hidden = count <= 0;
}
