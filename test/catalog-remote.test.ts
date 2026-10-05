import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteCatalog, fetchText, mergeById, type TextFetcher } from '../src/server/catalog/remote';
import { validateModels, type ModelsDoc } from '../src/server/catalog/models';
import { isCatalogUrl } from '../src/server/config';

const shipped: ModelsDoc = { updated: 'old', models: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
const remoteJson = JSON.stringify({ updated: 'new', models: [{ id: 'b', label: 'B2' }, { id: 'c', label: 'C' }, { id: 'bad id', label: 'x' }] });
function make(o: { url?: string; fetch?: TextFetcher; now?: () => number; dir?: string }) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'cat-'));
  return {
    dir,
    c: new RemoteCatalog<ModelsDoc>({
      name: 'm', shipped, url: () => o.url ?? 'https://x.test/m.json', cacheFile: join(dir, 'm.cache.json'), cacheHours: () => 6, validate: validateModels,
      merge: (a, b) => ({ updated: b.updated ?? a.updated, models: mergeById(a.models, b.models) }), updatedOf: (d) => d.updated,
      ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.now ? { now: o.now } : {}),
    }),
  };
}

it('no url: shipped only, no fetch', async () => {
  let calls = 0;
  const { c } = make({ url: '', fetch: async () => { calls++; return remoteJson; } });
  expect((await c.load()).source).toBe('shipped');
  expect(calls).toBe(0);
});
it('downloads, merges by id (remote wins), writes the cache; a second catalog within the age uses the cache', async () => {
  let t = 1_000_000;
  const { c, dir } = make({ fetch: async () => remoteJson, now: () => t });
  const r = await c.load();
  expect(r.source).toBe('remote');
  expect(r.data.models).toEqual([{ id: 'a', label: 'A' }, { id: 'b', label: 'B2' }, { id: 'c', label: 'C' }]);
  expect(r.updated).toBe('new');
  t += 3_600_000;
  const second = make({ dir, fetch: async () => { throw new Error('must not fetch'); }, now: () => t }).c;
  expect((await second.load()).source).toBe('cache');
});
it('a stale cache is refetched; a failed fetch falls back to the cache, then to the shipped list', async () => {
  let t = 1_000_000;
  const { c, dir } = make({ fetch: async () => remoteJson, now: () => t });
  await c.load();
  t += 7 * 3_600_000;
  const failing = make({ dir, fetch: async () => { throw new Error('down'); }, now: () => t }).c;
  const r = await failing.load();
  expect(r.source).toBe('cache');
  expect(r.data.models.map((m) => m.id)).toContain('c');
  const none = make({ fetch: async () => { throw new Error('down'); } }).c;
  expect((await none.load()).source).toBe('shipped');
});
it('a body that is not a catalog, or a cache of another address, is ignored', async () => {
  const { c, dir } = make({ fetch: async () => '{"nothing":1}' });
  expect((await c.load()).source).toBe('shipped');
  writeFileSync(join(dir, 'm.cache.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), url: 'https://other.test/', raw: JSON.parse(remoteJson) }));
  expect((await make({ dir, fetch: async () => { throw new Error('x'); } }).c.load()).source).toBe('shipped');
});
it('force skips the cache age', async () => {
  let n = 0;
  const { c } = make({ fetch: async () => { n++; return remoteJson; } });
  await c.load();
  await c.load(true);
  expect(n).toBe(2);
});
it('the default fetcher caps the size and reads local http', async () => {
  const server = http.createServer((req, res) => { res.end(req.url === '/big' ? 'x'.repeat(2 * 1024 * 1024) : '{"ok":1}'); });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as { port: number }).port;
  try {
    expect(await fetchText(`http://127.0.0.1:${port}/small`, { timeoutMs: 2000, maxBytes: 1024 * 1024 })).toBe('{"ok":1}');
    await expect(fetchText(`http://127.0.0.1:${port}/big`, { timeoutMs: 2000, maxBytes: 1024 * 1024 })).rejects.toThrow();
  } finally { server.close(); }
});
it('catalog url validation', () => {
  for (const ok of ['', 'https://example.com/a.json', 'http://127.0.0.1:80/a', 'http://localhost/a']) expect(isCatalogUrl(ok), ok).toBe(true);
  for (const bad of ['http://example.com/a', 'ftp://x/y', 'nope', 'https://u:p@example.com/', 5, null]) expect(isCatalogUrl(bad), String(bad)).toBe(false);
});
