import { join, resolve } from 'node:path';

/** Where the shipped folders live: the repository root in development, `resources/app-root` in the packaged app (it sets CONSOLE_APP_ROOT). */
export const appRoot = (): string => process.env.CONSOLE_APP_ROOT ?? resolve(import.meta.dirname, '..', '..');

export const resourcePath = (...parts: string[]): string => join(appRoot(), ...parts);
