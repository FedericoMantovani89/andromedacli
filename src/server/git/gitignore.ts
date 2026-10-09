import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeJsonAtomic } from '../fs-atomic';
import { readJsonFile } from '../json-file';

/** Whether the folder has a `.gitignore` of its own at its top (a repository, or a checkout of one). */
export const hasGitignore = (dir: string): boolean => existsSync(join(dir, '.gitignore'));

/**
 * Without a `.gitignore` the console's `git add -A` (one commit per step) would stage whatever the agent installed or built: node_modules,
 * build output, caches. The console cannot write a .gitignore for the user's code base, so the main asks the user and an agent that finds
 * none keeps its work clean and says so. Each repository is brought up to the main once: the answer ("no") is the user's.
 */
export class GitignoreAsked {
  constructor(private readonly file: string) {}

  private read(): string[] {
    const parsed = readJsonFile(this.file);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  }

  /** The repositories (relative names, '' for the project folder) not yet brought up; they are marked as brought up now. */
  take(missing: readonly string[]): string[] {
    const known = new Set(this.read());
    const fresh = missing.filter((r) => !known.has(r));
    if (fresh.length > 0) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        writeJsonAtomic(this.file, [...known, ...fresh]);
      } catch { /* not remembered: it may be asked once more, which costs nothing */ }
    }
    return fresh;
  }
}
