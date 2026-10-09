import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { UiAssets } from '../src/server/ui-assets';

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'h-ui-'));
  writeFileSync(join(d, 'app.js'), 'console.log(1)');
  writeFileSync(join(d, 'app.js.br'), Buffer.from([1, 2, 3]));
  writeFileSync(join(d, 'styles.css'), 'body{}');
  mkdirSync(join(d, 'chunks'));
  writeFileSync(join(d, 'chunks', 'options-ABC123.js'), 'export {}');
  return d;
}

it('serves a file with its type and a stable content ETag', () => {
  const a = new UiAssets(dir());
  const one = a.get('app.js')!;
  expect(one.body.toString()).toBe('console.log(1)');
  expect(one.type).toBe('text/javascript; charset=utf-8');
  expect(one.encoding).toBeUndefined();
  expect(a.get('app.js')!.etag).toBe(one.etag);
  expect(a.get('styles.css')!.etag).not.toBe(one.etag);
});
it('serves the precompressed .br file only when the client accepts br, with its own ETag', () => {
  const a = new UiAssets(dir());
  const plain = a.get('app.js', 'gzip')!;
  const br = a.get('app.js', 'gzip, deflate, br')!;
  expect(plain.encoding).toBeUndefined();
  expect([...br.body]).toEqual([1, 2, 3]);
  expect(br.encoding).toBe('br');
  expect(br.etag).not.toBe(plain.etag);
  expect(a.get('styles.css', 'br')!.encoding).toBeUndefined(); // no .br next to it
});
it('serves a chunk by its path under the folder and knows nothing that is not there', () => {
  const a = new UiAssets(dir());
  expect(a.get('chunks/options-ABC123.js')!.body.toString()).toBe('export {}');
  expect(a.get('nope.js')).toBeUndefined();
});
it('refuses a path that leaves the folder', () => {
  const a = new UiAssets(dir());
  for (const bad of ['../package.json', 'chunks/../../x', '..\\x', '/etc/passwd', 'C:/x']) expect(a.get(bad)).toBeUndefined();
});
it('reads a file once: it still answers after the file is gone', () => {
  const d = dir();
  const a = new UiAssets(d);
  expect(a.get('styles.css')).toBeDefined();
  rmSync(join(d, 'styles.css'));
  expect(a.get('styles.css')!.body.toString()).toBe('body{}');
});
it('with watch (development) a rebuilt file is read again, and one that disappears is gone', async () => {
  const d = dir();
  const a = new UiAssets(d, true);
  const before = a.get('styles.css')!.etag;
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(join(d, 'styles.css'), 'body{color:red}');
  expect(a.get('styles.css')!.etag).not.toBe(before);
  rmSync(join(d, 'styles.css'));
  expect(a.get('styles.css')).toBeUndefined();
});

it('a miss is not remembered (a page cannot grow the cache with made-up names), so a file that appears later is served', () => {
  const d = dir();
  const a = new UiAssets(d);
  expect(a.get('chunks/later-XYZ.js')).toBeUndefined();
  for (let i = 0; i < 50; i += 1) expect(a.get(`chunks/made-up-${i}.js`)).toBeUndefined();
  expect((a as unknown as { entries: Map<string, unknown> }).entries.size).toBe(0);
  writeFileSync(join(d, 'chunks', 'later-XYZ.js'), 'export {}');
  expect(a.get('chunks/later-XYZ.js')!.body.toString()).toBe('export {}');
});
