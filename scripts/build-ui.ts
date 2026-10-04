// Bundles the browser UI into dist/ui (served by the console server).
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'dist', 'ui');
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'ui', 'main.ts')],
  outfile: join(out, 'app.js'),
  bundle: true, format: 'esm', sourcemap: true, target: 'es2022', logLevel: 'info',
});
copyFileSync(join(root, 'src', 'ui', 'index.html'), join(out, 'index.html'));
copyFileSync(join(root, 'src', 'ui', 'styles.css'), join(out, 'styles.css'));
copyFileSync(join(root, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), join(out, 'xterm.css'));
