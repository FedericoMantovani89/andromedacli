import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { TicketStore } from '../src/server/tickets/store';

it('the repo of a ticket is kept in its file and survives a rename (a replacement agent)', () => {
  const s = new TicketStore(mkdtempSync(join(tmpdir(), 'tk-')));
  s.setRepo('fix-login', 'abc-fe');
  expect(s.get('fix-login')?.repo).toBe('abc-fe');
  s.rename('fix-login', 'fix-login-r1');
  expect(s.get('fix-login-r1')?.repo).toBe('abc-fe');
});
