import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface Detected { build?: string; test?: string; lint?: string; source?: 'pom.xml' | 'gradle' | 'package.json' }

const MAX_READ = 256 * 1024;

/** Reads at most 256 KiB of a text file; undefined when it is missing, too large or unreadable. */
function readBounded(file: string): string | undefined {
  try {
    if (!statSync(file).isFile() || statSync(file).size > MAX_READ) return undefined;
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(MAX_READ);
      const n = readSync(fd, buf, 0, MAX_READ, 0);
      return buf.subarray(0, n).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** The project's wrapper when it has one (`mvnw.cmd` on Windows, `./mvnw` elsewhere), else the tool from the PATH. */
function wrapper(root: string, base: string, ext: '.cmd' | '.bat', tool: string, platform: NodeJS.Platform): string {
  if (platform === 'win32' && existsSync(join(root, `${base}${ext}`))) return `${base}${ext}`;
  if (platform !== 'win32' && existsSync(join(root, base))) return `./${base}`;
  return tool;
}

/**
 * Proposes build/test/lint commands from what the project has (SPEC 21). Read-only: a few bounded file reads, no process is run.
 * Nothing found gives `{}`.
 */
export function detectProject(root: string, platform: NodeJS.Platform = process.platform): Detected {
  if (existsSync(join(root, 'pom.xml'))) {
    const mvn = wrapper(root, 'mvnw', '.cmd', 'mvn', platform);
    return { source: 'pom.xml', build: `${mvn} -q -DskipTests package`, test: `${mvn} test` };
  }
  if (existsSync(join(root, 'build.gradle')) || existsSync(join(root, 'build.gradle.kts'))) {
    const gradle = wrapper(root, 'gradlew', '.bat', 'gradle', platform);
    return { source: 'gradle', build: `${gradle} build -x test`, test: `${gradle} test` };
  }
  const text = readBounded(join(root, 'package.json'));
  if (text !== undefined) {
    let scripts: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(text) as { scripts?: unknown };
      if (typeof parsed.scripts === 'object' && parsed.scripts !== null && !Array.isArray(parsed.scripts)) scripts = parsed.scripts as Record<string, unknown>;
    } catch { /* a package.json that does not parse proposes nothing */ }
    const has = (name: string): boolean => typeof scripts[name] === 'string';
    const out: Detected = { source: 'package.json' };
    if (has('build')) out.build = 'npm run build';
    if (has('test')) out.test = 'npm test';
    if (has('lint')) out.lint = 'npm run lint';
    if (out.build || out.test || out.lint) return out;
  }
  return {};
}
