import { focusElementFromUser } from './focus';
import { k, setTitle } from './i18n-client';

const SVG = 'http://www.w3.org/2000/svg';
const SIZE = 220;
const MID = SIZE / 2;
const OUTER = 84; // radius of the ring of 1-12 (and of the minutes)
const INNER = 54; // radius of the ring of 13-00
const pad = (n: number): string => String(n).padStart(2, '0');

const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) e.setAttribute(name, String(value));
  return e;
};

/** Position on the dial of step `i` out of `steps`, clockwise from the top. */
const at = (i: number, steps: number, radius: number): { x: number; y: number } => {
  const a = (i / steps) * Math.PI * 2;
  return { x: MID + Math.sin(a) * radius, y: MID - Math.cos(a) * radius };
};

/**
 * A clock face for a 24-hour time. `input` holds the value ("HH:MM") and is the one the caller listens to: it is hidden, and a button that
 * shows the time opens the dial. Pick the hour (outer ring 1-12, inner ring 13-00), then the minute; the value is written to `input`, a
 * `change` event is dispatched and the dial closes. Clicking outside or Escape closes it without changing anything.
 */
export function attachClock(input: HTMLInputElement, labelKey: string): HTMLElement {
  input.type = 'hidden';
  const wrap = document.createElement('span');
  wrap.className = 'clock-field';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'clock-button';
  button.name = `${input.name}-clock`;
  setTitle(button, labelKey);
  const paint = (): void => { button.textContent = input.value; };
  input.addEventListener('change', paint);
  paint();
  wrap.append(input, button);

  let open: { close(): void } | undefined;
  button.addEventListener('click', () => {
    if (open) { open.close(); return; }
    open = openDial(wrap, button, input, () => { open = undefined; });
  });
  return wrap;
}

function openDial(wrap: HTMLElement, button: HTMLElement, input: HTMLInputElement, onClosed: () => void): { close(): void } {
  const [h0, m0] = (/^(\d{2}):(\d{2})$/.exec(input.value) ?? ['', '00', '00']).slice(1).map(Number) as [number, number];
  let hour = h0;
  let minute = m0;
  let mode: 'hour' | 'minute' = 'hour';

  const pop = document.createElement('div');
  pop.className = 'clock-popover';
  pop.setAttribute('role', 'dialog');
  const head = document.createElement('div');
  head.className = 'clock-head';
  const hourBtn = document.createElement('button');
  const minBtn = document.createElement('button');
  hourBtn.type = minBtn.type = 'button';
  setTitle(hourBtn, k('time.hours'));
  setTitle(minBtn, k('time.minutes'));
  const colon = document.createElement('span');
  colon.className = 'clock-colon'; // the colon is drawn by CSS: it is a separator, not text
  head.append(hourBtn, colon, minBtn);
  const face = svg('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, width: SIZE, height: SIZE, class: 'clock-face', tabindex: 0, role: 'slider' });
  pop.append(head, face);

  const draw = (): void => {
    hourBtn.textContent = pad(hour);
    minBtn.textContent = pad(minute);
    hourBtn.classList.toggle('active', mode === 'hour');
    minBtn.classList.toggle('active', mode === 'minute');
    face.replaceChildren(svg('circle', { cx: MID, cy: MID, r: MID - 4, class: 'clock-disc' }));
    let target: { x: number; y: number };
    if (mode === 'hour') {
      const outer = hour >= 1 && hour <= 12;
      target = at(hour % 12, 12, outer ? OUTER : INNER);
    } else {
      target = at(minute, 60, OUTER);
    }
    face.append(svg('line', { x1: MID, y1: MID, x2: target.x, y2: target.y, class: 'clock-hand' }), svg('circle', { cx: MID, cy: MID, r: 3, class: 'clock-pin' }),
      svg('circle', { cx: target.x, cy: target.y, r: 16, class: 'clock-mark' }));
    const label = (text: string, p: { x: number; y: number }, selected: boolean): void => {
      const t = svg('text', { x: p.x, y: p.y, class: selected ? 'clock-num selected' : 'clock-num', 'text-anchor': 'middle', 'dominant-baseline': 'central' });
      t.textContent = text;
      face.append(t);
    };
    if (mode === 'hour') {
      for (let i = 0; i < 12; i++) label(String(i === 0 ? 12 : i), at(i, 12, OUTER), hour === (i === 0 ? 12 : i));
      for (let i = 0; i < 12; i++) label(pad(i === 0 ? 0 : 12 + i), at(i, 12, INNER), hour === (i === 0 ? 0 : 12 + i));
    } else {
      for (let i = 0; i < 60; i += 5) label(pad(i), at(i, 60, OUTER), minute === i);
    }
    face.setAttribute('aria-valuenow', String(mode === 'hour' ? hour : minute));
  };

  const commit = (): void => {
    input.value = `${pad(hour)}:${pad(minute)}`;
    input.dispatchEvent(new Event('change'));
    close();
  };
  /** The hour or minute under a pointer: the angle gives the step, the distance from the centre the ring. */
  const pick = (ev: PointerEvent): void => {
    const r = face.getBoundingClientRect();
    const x = ev.clientX - r.left - r.width / 2;
    const y = ev.clientY - r.top - r.height / 2;
    const turn = (Math.atan2(x, -y) / (Math.PI * 2) + 1) % 1;
    if (mode === 'hour') {
      const step = Math.round(turn * 12) % 12;
      const outer = Math.hypot(x, y) / (r.width / SIZE) > (OUTER + INNER) / 2;
      hour = outer ? (step === 0 ? 12 : step) : (step === 0 ? 0 : 12 + step);
    } else {
      minute = Math.round(turn * 60) % 60;
    }
    draw();
  };
  let dragging = false;
  face.addEventListener('pointerdown', (ev) => { dragging = true; face.setPointerCapture(ev.pointerId); pick(ev); });
  face.addEventListener('pointermove', (ev) => { if (dragging) pick(ev); });
  face.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    if (mode === 'hour') { mode = 'minute'; draw(); } else commit();
  });
  // The keyboard: arrows step the value, Enter goes on (hour, then minute, then done).
  face.addEventListener('keydown', (ev) => {
    const step = ev.key === 'ArrowUp' || ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowDown' || ev.key === 'ArrowLeft' ? -1 : 0;
    if (step !== 0) {
      if (mode === 'hour') hour = (hour + step + 24) % 24; else minute = (minute + step + 60) % 60;
      draw();
      ev.preventDefault();
    } else if (ev.key === 'Enter') {
      if (mode === 'hour') { mode = 'minute'; draw(); } else commit();
      ev.preventDefault();
    }
  });
  hourBtn.addEventListener('click', () => { mode = 'hour'; draw(); });
  minBtn.addEventListener('click', () => { mode = 'minute'; draw(); });

  const onDown = (ev: PointerEvent): void => { if (!pop.contains(ev.target as Node) && !button.contains(ev.target as Node)) close(); };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return;
    ev.stopPropagation(); // only the dial closes, not the Options dialog behind it
    ev.preventDefault();
    close();
  };
  function close(): void {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    pop.remove();
    onClosed();
  }
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);

  wrap.append(pop);
  // Under the button, or above it when there is no room below.
  const b = button.getBoundingClientRect();
  const height = pop.offsetHeight || 290;
  pop.style.left = `${Math.max(8, Math.min(b.left, window.innerWidth - (SIZE + 32) - 8))}px`;
  pop.style.top = `${b.bottom + 6 + height > window.innerHeight ? Math.max(8, b.top - height - 6) : b.bottom + 6}px`;
  draw();
  focusElementFromUser(face as unknown as HTMLElement, 'user'); // the user just clicked the time: the cursor may go to the dial
  return { close };
}
