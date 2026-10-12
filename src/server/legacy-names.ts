import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The product used to be called AndromedaCli. A user's data keeps living under the old names until the first start of this version,
 * which moves it: the project folder `.andromedacli` and the settings folder `%APPDATA%/andromedacli`. Both moves are a plain rename, tried
 * once; when it fails (a file is open somewhere) nothing is changed and the new folder is simply started empty.
 */
const OLD_PROJECT_DIR = '.andromedacli';
const NEW_PROJECT_DIR = '.andromedaconsole';
const OLD_CONFIG_DIR = 'andromedacli';

/** The absolute paths stored in the project's state and in each worktree's own git config name the old folder: rewritten after the move. */
function rewriteTextFiles(dir: string, depth = 0): void {
  if (depth > 6) return;
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = join(dir, n);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (n !== 'worktrees' && n !== 'reading') rewriteTextFiles(p, depth + 1); continue; }
    if (!n.endsWith('.json') && !n.endsWith('.md')) continue;
    try {
      const s = readFileSync(p, 'utf8');
      if (s.includes(OLD_PROJECT_DIR)) writeFileSync(p, s.split(OLD_PROJECT_DIR).join(NEW_PROJECT_DIR), 'utf8');
    } catch { /* an unreadable file stays as it is */ }
  }
}

const hasGit = (dir: string): boolean => existsSync(join(dir, '.git'));

/** The repositories of a project folder: itself, or its direct sub-repositories. */
function reposOf(root: string): string[] {
  if (hasGit(root)) return [root];
  try { return readdirSync(root).map((n) => join(root, n)).filter((p) => { try { return statSync(p).isDirectory() && hasGit(p); } catch { return false; } }); } catch { return []; }
}

/** Git remembers each worktree by its path: after the move `git worktree repair` points it at the new place, and the worktree's own hooksPath is rewritten. */
function repairWorktrees(root: string, base: string): void {
  for (const repo of reposOf(root)) {
    const dirs: string[] = [];
    const collect = (d: string, depth: number): void => {
      let names: string[];
      try { names = readdirSync(d); } catch { return; }
      for (const n of names) {
        const p = join(d, n);
        if (existsSync(join(p, '.git'))) dirs.push(p); else if (depth < 1) collect(p, depth + 1);
      }
    };
    collect(base, 0);
    if (dirs.length === 0) continue;
    try { execFileSync('git', ['-C', repo, 'worktree', 'repair', ...dirs], { stdio: 'ignore', timeout: 20000 }); } catch { /* repaired on the next start */ }
    try {
      const wtRoot = join(repo, '.git', 'worktrees');
      for (const n of readdirSync(wtRoot)) {
        const cfg = join(wtRoot, n, 'config.worktree');
        if (!existsSync(cfg)) continue;
        const s = readFileSync(cfg, 'utf8');
        if (s.includes(OLD_PROJECT_DIR)) writeFileSync(cfg, s.split(OLD_PROJECT_DIR).join(NEW_PROJECT_DIR), 'utf8');
      }
    } catch { /* no linked worktrees */ }
  }
}

/** Moves `<root>/.andromedacli` to `<root>/.andromedaconsole` (once; nothing happens when the old folder is missing or the new one exists). */
export function migrateProjectFolder(root: string): void {
  const from = join(root, OLD_PROJECT_DIR);
  const to = join(root, NEW_PROJECT_DIR);
  if (!existsSync(from) || existsSync(to)) return;
  try { renameSync(from, to); } catch { return; }
  rewriteTextFiles(to);
  repairWorktrees(root, join(to, 'worktrees'));
}

/** Moves the settings folder `%APPDATA%/andromedacli` to `%APPDATA%/andromedaconsole` (once). */
export function migrateConfigFolder(appData: string): void {
  const from = join(appData, OLD_CONFIG_DIR);
  const to = join(appData, 'andromedaconsole');
  if (!existsSync(from) || existsSync(to)) return;
  try { renameSync(from, to); } catch { /* the new folder starts empty */ }
}
