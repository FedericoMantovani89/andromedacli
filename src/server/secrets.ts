import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJsonFile } from './json-file';

/**
 * Console-wide secrets (today only the Groq key of the voice dictation). They live in their own file under the config folder, not in
 * config.json: that file is sent to the browser by GET /api/options and patched by PUT /api/config, and a secret must do neither. The
 * folder is the user's own (%APPDATA%); on systems with file modes the file is also made readable by its owner only. Templates, copy
 * settings and project export read the project folder and `templates/`, never this file.
 */
export const secretsPath = (configDir: string): string => join(configDir, 'secrets.json');

export const GROQ_KEY_MIN = 8;
export const GROQ_KEY_MAX = 256;

/** A key is one printable ASCII token: no spaces, no control characters, a bounded length (it goes into a header). */
export const isValidGroqKey = (v: unknown): v is string =>
  typeof v === 'string' && v.length >= GROQ_KEY_MIN && v.length <= GROQ_KEY_MAX && /^[\x21-\x7e]+$/.test(v);

/** The saved key, or undefined when there is none or the file cannot be read (never throws). */
export function readGroqKey(configDir: string): string | undefined {
  const raw = readJsonFile(secretsPath(configDir));
  const key = typeof raw === 'object' && raw !== null ? (raw as { groqKey?: unknown }).groqKey : undefined;
  return isValidGroqKey(key) ? key : undefined;
}

export const hasGroqKey = (configDir: string): boolean => readGroqKey(configDir) !== undefined;

/** Saves the key (replacing any), or removes it with `null`. The caller has validated it. */
export function writeGroqKey(configDir: string, key: string | null): void {
  const path = secretsPath(configDir);
  if (key === null) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ schema: 1, groqKey: key }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* not supported on this file system */ }
  renameSync(tmp, path);
}
