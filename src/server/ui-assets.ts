import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg', '.map': 'application/json',
};

export interface UiAsset { body: Buffer; type: string; etag: string; encoding?: 'br' }

interface Entry { body: Buffer; type: string; etag: string; mtimeMs: number; br?: { body: Buffer; etag: string } }

/**
 * The built UI files (SPEC 33.2): each is read once, gets an ETag from its bytes and, when the build left a `.br` next to it,
 * is served compressed to a client that accepts it. A name is only what is inside the folder: nothing leaves it.
 * `watch` (development) checks the file's time on every request, so a rebuilt UI is seen without restarting the server.
 */
export class UiAssets {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly dir: string, private readonly watch = false) {}

  get(file: string, acceptEncoding = ''): UiAsset | undefined {
    if (!/^[\w.-]+(\/[\w.-]+)*$/.test(file) || file.split('/').includes('..')) return undefined;
    let e: Entry | null | undefined = this.entries.get(file);
    if (e === undefined || (this.watch && this.changed(file, e))) {
      e = this.load(file);
      // Only what exists is remembered: any name can be asked for, and a miss kept for each would grow without limit.
      if (e) this.entries.set(file, e);
      else this.entries.delete(file);
    }
    if (!e) return undefined;
    if (e.br && /\bbr\b/.test(acceptEncoding)) return { body: e.br.body, type: e.type, etag: e.br.etag, encoding: 'br' };
    return { body: e.body, type: e.type, etag: e.etag };
  }

  private changed(file: string, e: Entry): boolean {
    try { return statSync(join(this.dir, normalize(file))).mtimeMs !== e.mtimeMs; } catch { return true; }
  }

  private load(file: string): Entry | null {
    const path = join(this.dir, normalize(file));
    if (!existsSync(path)) return null;
    const body = readFileSync(path);
    const ext = file.slice(file.lastIndexOf('.'));
    const etag = (b: Buffer): string => `"${createHash('sha1').update(b).digest('base64url').slice(0, 22)}"`;
    const brPath = `${path}.br`;
    const br = existsSync(brPath) ? readFileSync(brPath) : undefined;
    return { body, type: TYPES[ext] ?? 'application/octet-stream', etag: etag(body), mtimeMs: statSync(path).mtimeMs, ...(br ? { br: { body: br, etag: etag(br) } } : {}) };
  }
}
