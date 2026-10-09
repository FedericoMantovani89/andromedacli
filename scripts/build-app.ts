// `npm run build:app`: everything the desktop app is made of, in `out/` (SPEC 33.3); `electron-builder` packs it.
//   out/main/index.mjs   the Electron entry with the whole server inside (only electron, node-pty and node-notifier stay outside)
//   out/app-root/        the shipped folders the server reads at run time (prompts, catalog, templates, mod, UI, texts)
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildUi } from './build-ui.ts';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'out');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'main'), { recursive: true });

const ui = await buildUi({ map: false });

await build({
  entryPoints: [join(root, 'src', 'electron', 'main.ts')],
  outfile: join(out, 'main', 'index.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node24', minify: true, logLevel: 'info',
  // `ws` looks for these two optional speed-ups in a try/catch; node-pty and node-notifier carry native files, so they stay files.
  external: ['electron', 'node-pty', 'node-notifier', 'bufferutil', 'utf-8-validate'],
  // Bundled CommonJS packages (ws) call `require`: an ES module has none of its own.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

const appRoot = join(out, 'app-root');
const copy = (from: string, to = from, filter?: (src: string) => boolean): void => {
  cpSync(join(root, from), join(appRoot, to), { recursive: true, ...(filter ? { filter } : {}) });
};
copy('prompts');
copy('catalog');
copy('templates');
copy('mod/hooks');
copy('mod/.claude-plugin/plugin.json');
cpSync(ui, join(appRoot, 'dist', 'ui'), { recursive: true });
copy('src/i18n', 'src/i18n', (src) => !/\.(ts|map)$/.test(src));

const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
// The server reads the version from the `package.json` of the app root.
writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: 'andromedacli', version }, null, 2));
console.log(`app built in ${out}`);
