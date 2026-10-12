import { createServer, request } from 'node:http';
import { expect, it } from 'vitest';
import { readRaw } from '../src/server/http-util';

// The report called this a hang (B7). In the real flow the response is sent after the body is read, and Node then emits `error`
// (ECONNRESET) on an interrupted request, which `readRaw` already turns into a rejection: this test pins that.
it('rejects when the client goes away before the whole body arrived (B7)', async () => {
  const outcome = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const timer = setTimeout(() => resolve('still pending after the client aborted'), 1500);
      readRaw(req, 1000).then(() => { clearTimeout(timer); resolve('resolved'); res.end(); }, (e: Error) => { clearTimeout(timer); resolve(`rejected: ${e.message}`); });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      const r = request({ host: '127.0.0.1', port, method: 'POST', headers: { 'content-length': '500' } });
      r.on('error', () => undefined);
      r.write('x'.repeat(100));
      setTimeout(() => r.destroy(), 100);
      setTimeout(() => server.close(), 1800);
    });
    setTimeout(() => reject(new Error('no outcome')), 3000);
  });
  expect(outcome).toMatch(/^rejected/);
});

it('still resolves a complete body', async () => {
  const bytes = await new Promise<string>((resolve) => {
    const server = createServer((req, res) => { void readRaw(req, 1000).then((r) => { resolve(r.bytes.toString()); res.end(); server.close(); }); });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      const r = request({ host: '127.0.0.1', port, method: 'POST' });
      r.end('hello');
    });
  });
  expect(bytes).toBe('hello');
});
