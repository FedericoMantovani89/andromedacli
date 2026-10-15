import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TicketStore } from '../src/server/tickets/store';
import { removeDir } from './git-helpers';

// `moveFails` simulates a damaged file whose rename into `.corrupt-*` failed (antivirus, a lock): the file stays where it is.
let moveFails = false;
vi.mock('../src/server/json-file', async (orig) => {
  const real = await orig<typeof import('../src/server/json-file')>();
  return {
    ...real,
    readJsonState: (path: string, report?: Parameters<typeof real.readJsonState>[1], now?: Parameters<typeof real.readJsonState>[2]) =>
      moveFails ? { status: 'corrupt' as const } : real.readJsonState(path, report, now),
  };
});

let root: string;
beforeEach(() => { moveFails = false; root = mkdtempSync(join(tmpdir(), 'tickets-unreadable-')); });
afterEach(() => removeDir(root));
const folder = (): string => join(root, '.andromedaconsole', 'state', 'tickets');
const file = (): string => join(folder(), 'a.json');
const damage = (): void => { mkdirSync(folder(), { recursive: true }); writeFileSync(file(), '{ not json'); };

describe('TicketStore on a damaged file', () => {
  it('refuses to write over one it could not set aside, and leaves it byte for byte', () => {
    damage();
    moveFails = true;
    const s = new TicketStore(root);
    expect(s.get('a')).toBeUndefined();
    expect(() => s.setGoal('a', 'g')).toThrow('ticket.unreadable');
    expect(() => s.block('a', 'why')).toThrow('ticket.unreadable');
    expect(readFileSync(file(), 'utf8')).toBe('{ not json');
  });
  it('starts a fresh ticket when the damaged file was set aside', () => {
    damage();
    const s = new TicketStore(root);
    expect(s.setGoal('a', 'g')).toMatchObject({ slug: 'a', goal: 'g', status: 'in_progress', steps: [] });
  });
  it('still starts a ticket nobody has seen', () => {
    expect(new TicketStore(root).setGoal('new', 'g').goal).toBe('g');
  });
});
