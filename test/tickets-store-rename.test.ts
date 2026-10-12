import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { TicketStore } from '../src/server/tickets/store';

let root: string;
let dir: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ticket-rename-')); dir = join(root, '.andromedaconsole', 'state', 'tickets'); mkdirSync(dir, { recursive: true }); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('moves the file and the slug together, leaving one ticket', () => {
  const t = new TicketStore(root);
  t.setGoal('old-name', 'goal');
  const moved = t.rename('old-name', 'new-name');
  expect(moved.slug).toBe('new-name');
  expect(existsSync(join(dir, 'old-name.json'))).toBe(false);
  expect(JSON.parse(readFileSync(join(dir, 'new-name.json'), 'utf8')).slug).toBe('new-name');
  expect(t.list().map((x) => x.slug)).toEqual(['new-name']);
});

it('refuses a name that is taken', () => {
  const t = new TicketStore(root);
  t.setGoal('a-1', 'x');
  t.setGoal('b-2', 'y');
  expect(() => t.rename('a-1', 'b-2')).toThrow('ticket.exists');
});

it('a crash between the file move and the slug rewrite leaves one ticket, healed on the next read (B6)', () => {
  const t = new TicketStore(root);
  t.setGoal('old-name', 'goal');
  // What a crash after the rename leaves: the file has its new name and the old slug inside.
  writeFileSync(join(dir, 'new-name.json'), readFileSync(join(dir, 'old-name.json'), 'utf8'));
  rmSync(join(dir, 'old-name.json'));
  const read = t.get('new-name');
  expect(read?.slug).toBe('new-name');
  expect(JSON.parse(readFileSync(join(dir, 'new-name.json'), 'utf8')).slug).toBe('new-name');
  expect(t.list().length).toBe(1);
});
