import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RequestStore, type RequestRecord } from '../src/server/requests/store';

const file = (): string => join(mkdtempSync(join(tmpdir(), 'req-')), 'state', 'requests.json');
const rec = (id: string, over: Partial<RequestRecord> = {}): RequestRecord =>
  ({ id, from: 'fe-pages', to: 'be-orders', text: 'q', state: 'open', hops: 0, createdAt: 1000, ...over });

it('keeps ids, state, deadline and message id across a restart', () => {
  const f = file();
  const a = new RequestStore(f);
  a.add(rec('TODO-000001', { messageId: 'm1', deadline: 5000 }));
  a.update('TODO-000001', { deliveredAt: 2000 });
  const b = new RequestStore(f);
  b.load();
  expect(b.get('TODO-000001')).toMatchObject({ messageId: 'm1', deadline: 5000, deliveredAt: 2000, state: 'open' });
});
it('update with undefined removes the field and an unknown id changes nothing', () => {
  const s = new RequestStore();
  s.add(rec('TODO-000001', { deadline: 5000 }));
  expect(s.update('TODO-000001', { deadline: undefined })!.deadline).toBeUndefined();
  expect('deadline' in s.get('TODO-000001')!).toBe(false);
  expect(s.update('TODO-ffffff', { state: 'answered' })).toBeUndefined();
});
it('a missing or damaged file is no requests, and a damaged record is skipped', () => {
  const missing = new RequestStore(file()); missing.load();
  expect(missing.list()).toEqual([]);
  const f = file();
  new RequestStore(f).add(rec('TODO-000001'));
  writeFileSync(f, JSON.stringify([rec('TODO-000002'), { id: 'TODO-000003', state: 'weird' }, 'junk']));
  const s = new RequestStore(f); s.load();
  expect(s.list().map((r) => r.id)).toEqual(['TODO-000002']);
  writeFileSync(f, '{not json');
  const t = new RequestStore(f); t.load();
  expect(t.list()).toEqual([]);
});
