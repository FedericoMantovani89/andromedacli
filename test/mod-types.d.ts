// The console mod is plain JavaScript loaded by Claude Code; tests import it directly.
declare module '*/hooks/register.js' {
  export const register: (on: (event: string, a: unknown, b?: unknown) => void) => void;
}
