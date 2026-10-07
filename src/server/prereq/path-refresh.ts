import { execFile } from 'node:child_process';

const MACHINE_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const USER_KEY = 'HKCU\\Environment';

/** `%NAME%` references are expanded from this process's environment (a value that cannot be expanded is kept as it is). */
const expand = (value: string): string => value.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole);

/** What `reg query <key> /v Path` prints: `    Path    REG_EXPAND_SZ    C:\a;C:\b`. */
export function parseRegPath(output: string): string[] {
  const line = output.split(/\r?\n/).find((l) => /^\s+path\s+REG_(EXPAND_)?SZ\s+/i.test(l));
  if (!line) return [];
  const value = line.replace(/^\s+path\s+REG_(EXPAND_)?SZ\s+/i, '').trim();
  return expand(value).split(';').map((p) => p.trim()).filter((p) => p !== '');
}

/** The machine entries, then the user's, then whatever this process already had; nothing twice (the comparison ignores case). */
export function mergePath(machine: string[], user: string[], current: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...machine, ...user, ...current.split(';')]) {
    const clean = p.trim();
    if (clean === '' || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    out.push(clean);
  }
  return out.join(';');
}

const query = (key: string): Promise<string> =>
  new Promise((done) => {
    execFile('reg', ['query', key, '/v', 'Path'], { windowsHide: true, timeout: 10_000 }, (err, stdout) => done(err ? '' : stdout));
  });

/**
 * A program installed after the console started is not on the PATH this process inherited (Windows gives a program the PATH it started
 * with). Reads the PATH the system holds now and puts it in this process, so the sessions launched next see the new program without the
 * console itself being restarted. Does nothing off Windows; a failed read leaves the PATH as it was.
 */
export async function refreshProcessPath(): Promise<void> {
  if (process.platform !== 'win32') return;
  const [machine, user] = await Promise.all([query(MACHINE_KEY), query(USER_KEY)]);
  const merged = mergePath(parseRegPath(machine), parseRegPath(user), process.env.PATH ?? process.env.Path ?? '');
  if (merged !== '') process.env.PATH = merged;
}
