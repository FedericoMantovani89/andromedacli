import { expect, it, vi } from 'vitest';
import { budgetAnswerHandler, raisedLimit } from '../src/server/budget/answers';
import type { TicketStatus } from '../src/server/tickets/flow';

type StartResult = { ok: true; recovery: string; attempt: number } | { ok: false; code: string; detail?: string };
type RestartResult = { ok: true; agent: string } | { ok: false; code: string; detail?: string };

function setup(o: { status?: TicketStatus; limit?: number; used?: number; start?: StartResult; restart?: RestartResult } = {}) {
  let status: TicketStatus = o.status ?? 'suspended_budget';
  const usage = o.limit === undefined ? undefined : { used: o.used ?? 900, limit: o.limit, step: 'stopped' as const };
  const deps = {
    budget: { usage: vi.fn(() => usage) },
    tickets: { get: vi.fn(() => ({ status })), move: vi.fn((_s: string, to: TicketStatus) => { status = to; return {} as never; }) },
    recovery: {
      start: vi.fn(async (): Promise<StartResult> => o.start ?? { ok: true, recovery: 'recover-fix-login', attempt: 1 }),
      restart: vi.fn(async (): Promise<RestartResult> => o.restart ?? { ok: true, agent: 'fix-login-r2' }),
    },
    tellMain: vi.fn(),
    changed: vi.fn(),
  };
  return { deps, handle: budgetAnswerHandler(deps), status: () => status };
}

it('raisedLimit: half again, rounded, from the usage when it went past the limit', () => {
  expect(raisedLimit(1001, 900)).toBe(1502);
  expect(raisedLimit(1000, 1600)).toBe(2400);
});

it('raise: the limit grows by half (rounded) and a new agent takes the ticket over on the same branch', async () => {
  const { deps, handle } = setup({ limit: 1001 });
  await handle('raise', { ticket: 'fix-login' });
  expect(deps.recovery.restart).toHaveBeenCalledWith('fix-login', { limit: 1502 });
  expect(deps.tellMain).toHaveBeenCalledTimes(1);
  expect(deps.tellMain.mock.calls[0]![0]).toMatch(/fix-login-r2/);
  expect(deps.tellMain.mock.calls[0]![0]).toMatch(/1502/);
  expect(deps.changed).toHaveBeenCalled();
});

it('raise starts from the usage when it went past the limit, so the new limit is not already used up', async () => {
  const { deps, handle } = setup({ limit: 1000, used: 1600 });
  await handle('raise', { ticket: 'fix-login' });
  expect(deps.recovery.restart).toHaveBeenCalledWith('fix-login', { limit: 2400 });
});

it('raise whose restart is refused tells the main the code', async () => {
  const { deps, handle } = setup({ limit: 1000, restart: { ok: false, code: 'spawn_failed', detail: 'no room' } });
  await handle('raise', { ticket: 'fix-login' });
  expect(deps.tellMain).toHaveBeenCalledTimes(1);
  expect(deps.tellMain.mock.calls[0]![0]).toMatch(/spawn_failed/);
});

it('raise without a known budget changes nothing and tells the main', async () => {
  const { deps, handle } = setup({});
  await handle('raise', { ticket: 'fix-login' });
  expect(deps.recovery.restart).not.toHaveBeenCalled();
  expect(deps.tellMain).toHaveBeenCalledTimes(1);
});

it('close: the ticket goes to needs_user and the main is told', async () => {
  const { deps, handle, status } = setup({ limit: 1000 });
  await handle('close', { ticket: 'fix-login' });
  expect(deps.tickets.move).toHaveBeenCalledWith('fix-login', 'needs_user');
  expect(status()).toBe('needs_user');
  expect(deps.tellMain).toHaveBeenCalledTimes(1);
  expect(deps.tellMain.mock.calls[0]![0]).toMatch(/fix-login/);
});

it('close when the table does not allow needs_user: no move, the main is still told', async () => {
  const { deps, handle } = setup({ status: 'released', limit: 1000 });
  await handle('close', { ticket: 'fix-login' });
  expect(deps.tickets.move).not.toHaveBeenCalled();
  expect(deps.tellMain).toHaveBeenCalledTimes(1);
});

it('recover: the console starts the recovery agent and tells the main', async () => {
  const { deps, handle } = setup({ limit: 1000 });
  await handle('recover', { ticket: 'fix-login' });
  expect(deps.recovery.start).toHaveBeenCalledWith('fix-login');
  expect(deps.tellMain).toHaveBeenCalledTimes(1);
  expect(deps.tellMain.mock.calls[0]![0]).toMatch(/recover-fix-login/);
  expect(deps.recovery.restart).not.toHaveBeenCalled();
  expect(deps.tickets.move).not.toHaveBeenCalled();
});

it('recover refused: the main hears the code', async () => {
  const { deps, handle } = setup({ limit: 1000, start: { ok: false, code: 'too_many' } });
  await handle('recover', { ticket: 'fix-login' });
  expect(deps.tellMain).toHaveBeenCalledTimes(1);
  expect(deps.tellMain.mock.calls[0]![0]).toMatch(/too_many/);
});

it('an unknown answer or a payload without a ticket does nothing', async () => {
  const { deps, handle } = setup({ limit: 1000 });
  await handle('maybe', { ticket: 'fix-login' });
  await handle('raise', {} as { ticket: string });
  expect(deps.tellMain).not.toHaveBeenCalled();
  expect(deps.recovery.restart).not.toHaveBeenCalled();
  expect(deps.recovery.start).not.toHaveBeenCalled();
  expect(deps.tickets.move).not.toHaveBeenCalled();
});

it('close while a recovery runs on the ticket is refused: no move, the main hears why', async () => {
  const { deps, handle, status } = setup({ status: 'recovering', limit: 1000 });
  await handle('close', { ticket: 'fix-login' });
  expect(deps.tickets.move).not.toHaveBeenCalled();
  expect(status()).toBe('recovering');
  expect(deps.tellMain).toHaveBeenCalledTimes(1);
  expect(deps.tellMain.mock.calls[0]![0]).toMatch(/recovering/);
});
