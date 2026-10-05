import { it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inbox } from '../src/server/agents/inbox';

const file = () => join(mkdtempSync(join(tmpdir(), 'inbox-')), 'state', 'inbox.json');

it('undelivered messages survive a restart and an acked one is never redelivered', () => {
  const f = file();
  const a = new Inbox(f);
  const id1 = a.push('worker', 'one');
  a.push('worker', 'two');
  a.ack('worker', id1);
  const b = new Inbox(f);
  b.load();
  expect(b.pending('worker').map((m) => m.text)).toEqual(['two']);
  expect(b.ack('worker', id1)).toBe(false);
});
it('clear is saved', () => {
  const f = file();
  const a = new Inbox(f);
  a.push('x', 'hello');
  a.clear('x');
  const b = new Inbox(f); b.load();
  expect(b.pending('x')).toEqual([]);
});
it('freeze stops writing (the processes ending at shutdown must not empty the file)', () => {
  const f = file();
  const a = new Inbox(f);
  a.push('worker', 'keep me');
  a.freeze();
  a.clear('worker');
  const b = new Inbox(f); b.load();
  expect(b.pending('worker').map((m) => m.text)).toEqual(['keep me']);
});
it('onPush is called with the slug after each push and a throwing callback is ignored', () => {
  const a = new Inbox();
  const seen: string[] = [];
  a.onPush(() => { throw new Error('boom'); });
  a.onPush((s) => seen.push(s));
  a.push('w', 'm');
  expect(seen).toEqual(['w']);
  expect(a.slugs()).toEqual(['w']);
});
