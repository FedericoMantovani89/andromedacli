// Bundles the browser UI into dist/ui (served by the console server).
//   --map   also writes source maps (development only: they are 3x the size of the code and are never packaged).
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');

/** Every `.js` and `.css` under `dir` (the folder is small: the UI is one entry and a few lazy chunks). */
function filesToCompress(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesToCompress(path);
    return /\.(js|css)$/.test(name) ? [path] : [];
  });
}

export async function buildUi(opts: { map: boolean; outDir?: string } = { map: false }): Promise<string> {
  const out = opts.outDir ?? join(root, 'dist', 'ui');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: { app: join(root, 'src', 'ui', 'main.ts') },
    outdir: out, entryNames: '[name]', chunkNames: 'chunks/[name]-[hash]',
    bundle: true, splitting: true, format: 'esm', minify: true, sourcemap: opts.map, target: 'es2022', logLevel: 'info',
  });
  copyFileSync(join(root, 'src', 'ui', 'index.html'), join(out, 'index.html'));
  copyFileSync(join(root, 'src', 'ui', 'styles.css'), join(out, 'styles.css'));
  copyFileSync(join(root, 'src', 'ui', 'splash.jpg'), join(out, 'splash.jpg'));
  copyFileSync(join(root, 'src', 'ui', 'favicon.png'), join(out, 'favicon.png'));
  copyFileSync(join(root, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), join(out, 'xterm.css'));
  // The server sends the Brotli copy to a client that accepts it (SPEC 33.2): the text files are about a quarter of their size.
  for (const file of filesToCompress(out)) {
    writeFileSync(`${file}.br`, brotliCompressSync(readFileSync(file), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await buildUi({ map: process.argv.includes('--map') });
}
