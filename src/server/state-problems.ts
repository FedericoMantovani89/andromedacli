import { relative } from 'node:path';
import type { StateReport } from './json-file';

export interface StateProblem { file: string; movedTo: string; at: string }

const MAX = 20;
const rel = (root: string, p: string): string => relative(root, p).replace(/\\/g, '/') || p;

/** What the console set aside because it could not read it, newest last. The page shows it until the user dismisses it. */
export class StateProblems {
  private items: StateProblem[] = [];

  constructor(private readonly root: string, private readonly changed: () => void = () => undefined, private readonly now: () => Date = () => new Date()) {}

  /** The callback the stores take. */
  readonly add: StateReport = (file, movedTo) => {
    this.items.push({ file: rel(this.root, file), movedTo: rel(this.root, movedTo), at: this.now().toISOString() });
    if (this.items.length > MAX) this.items.shift();
    this.changed();
  };

  list(): StateProblem[] { return [...this.items]; }

  clear(): void { this.items = []; this.changed(); }
}
