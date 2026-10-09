import { readFileSync } from 'node:fs';

/**
 * The parsed JSON of a file, or `undefined` when it is missing, unreadable or damaged: a state file that cannot be read is treated as
 * "nothing saved", never as a reason to stop the console. The caller checks the shape of what it gets.
 */
export function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}
