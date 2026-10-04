/** Minimal .properties reader: UTF-8, key=value, '#' comments, \n and \\ escapes. */
export function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq <= 0) throw new Error(`properties: line ${i + 1} has no "key=value"`);
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/\\(n|\\)/g, (_m, c) => (c === 'n' ? '\n' : '\\'));
    if (key in out) throw new Error(`properties: duplicate key "${key}" at line ${i + 1}`);
    out[key] = value;
  });
  return out;
}
