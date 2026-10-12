import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Inbox } from '../src/server/agents/inbox';
import { ProjectStore } from '../src/server/project-store';
import { RequestStore } from '../src/server/requests/store';
import { TicketStore } from '../src/server/tickets/store';

let root: string;
let state: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'quarantine-')); state = join(root, '.andromedaconsole', 'state'); mkdirSync(join(state, 'tickets'), { recursive: true }); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const copies = (dir: string, name: string): string[] => readdirSync(dir).filter((n) => n.startsWith(`${name}.corrupt-`));

describe('agents.json', () => {
  it('a damaged file is set aside and reported; the next agent does not wipe the others silently', () => {
    const report = vi.fn();
    writeFileSync(join(state, 'agents.json'), '[{"slug":"a-1"');
    const store = new ProjectStore(root, report);
    expect(store.listAgents()).toEqual([]);
    expect(report).toHaveBeenCalledTimes(1);
    expect(copies(state, 'agents.json').length).toBe(1);
    store.addAgent({ slug: 'b-2', profile: 'developer' });
    expect(store.listAgents().map((a) => a.slug)).toEqual(['b-2']);
    expect(copies(state, 'agents.json').length).toBe(1); // the damaged copy is still there
  });
  it('a file that parses but is not a list is set aside too (Review Focus 2)', () => {
    const report = vi.fn();
    writeFileSync(join(state, 'agents.json'), '{}');
    const store = new ProjectStore(root, report);
    expect(store.listAgents()).toEqual([]);
    expect(report).toHaveBeenCalledTimes(1);
    expect(existsSync(join(state, 'agents.json'))).toBe(false);
  });
  it('a good file is read as before and never reported', () => {
    const report = vi.fn();
    writeFileSync(join(state, 'agents.json'), '[{"slug":"a-1","profile":"developer","createdAt":"x"}]');
    expect(new ProjectStore(root, report).listAgents().length).toBe(1);
    expect(report).not.toHaveBeenCalled();
  });
});

describe('ticket files', () => {
  it('a damaged ticket is set aside, reported, and read as no ticket', () => {
    const report = vi.fn();
    writeFileSync(join(state, 'tickets', 'fix-login.json'), '{"slug":"fix-login"');
    const tickets = new TicketStore(root, report);
    expect(tickets.get('fix-login')).toBeUndefined();
    expect(report).toHaveBeenCalledTimes(1);
    expect(copies(join(state, 'tickets'), 'fix-login.json').length).toBe(1);
  });
  it('a file that parses but has no steps is set aside too (Review Focus 2)', () => {
    const report = vi.fn();
    writeFileSync(join(state, 'tickets', 'fix-login.json'), '{"slug":"fix-login"}');
    expect(new TicketStore(root, report).get('fix-login')).toBeUndefined();
    expect(report).toHaveBeenCalledTimes(1);
  });
  it('list() sets aside each damaged ticket once and returns the good ones', () => {
    const report = vi.fn();
    const tickets = new TicketStore(root, report);
    tickets.setGoal('good-one', 'x');
    writeFileSync(join(state, 'tickets', 'bad-one.json'), 'nope');
    expect(tickets.list().map((t) => t.slug)).toEqual(['good-one']);
    expect(tickets.list().map((t) => t.slug)).toEqual(['good-one']);
    expect(report).toHaveBeenCalledTimes(1);
  });
});

describe('requests.json and inbox.json', () => {
  it('requests: a damaged file is set aside and reported', () => {
    const report = vi.fn();
    const file = join(state, 'requests.json');
    writeFileSync(file, '[{');
    const s = new RequestStore(file, report);
    s.load();
    expect(s.list()).toEqual([]);
    expect(report).toHaveBeenCalledTimes(1);
  });
  it('inbox: a damaged file is set aside and reported', () => {
    const report = vi.fn();
    const file = join(state, 'inbox.json');
    writeFileSync(file, '{{');
    const box = new Inbox(file, report);
    box.load();
    expect(report).toHaveBeenCalledTimes(1);
    expect(existsSync(file)).toBe(false);
  });
});
