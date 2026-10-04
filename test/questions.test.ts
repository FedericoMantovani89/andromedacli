import { it, expect, vi } from 'vitest';
import { QuestionQueue } from '../src/server/questions/queue';

const q = (from = 'fix-login', text = 'Which color?', options?: string[]) => ({ from, text, options });

it('a new question is pending, with its options', () => {
  const queue = new QuestionQueue();
  const { id } = queue.ask(q('fix-login', 'Which color?', ['Red', 'Blue']));
  expect(queue.pending()).toMatchObject([{ id, from: 'fix-login', text: 'Which color?', options: ['Red', 'Blue'] }]);
});
it('an answer resolves a waiting long-poll immediately and removes the question from the queue', async () => {
  const queue = new QuestionQueue();
  const { id } = queue.ask(q());
  const waiting = queue.wait(id, 5000);
  expect(queue.answer(id, 'Red')).toBe('ok');
  expect(await waiting).toEqual({ answered: true, answer: 'Red' });
  expect(queue.pending()).toEqual([]);
});
it('wait times out with answered:false and keeps the question', async () => {
  const queue = new QuestionQueue();
  const { id } = queue.ask(q());
  expect(await queue.wait(id, 30)).toEqual({ answered: false });
  expect(queue.pending()).toHaveLength(1);
});
it('a wait that starts after the answer still gets it', async () => {
  const queue = new QuestionQueue();
  const { id } = queue.ask(q());
  queue.answer(id, 'Blue');
  expect(await queue.wait(id, 1000)).toEqual({ answered: true, answer: 'Blue' });
});
it('answering twice, an unknown id and an empty answer are told apart', () => {
  const queue = new QuestionQueue();
  const { id } = queue.ask(q());
  expect(queue.answer(id, '   ')).toBe('invalid');
  expect(queue.answer(id, 'Red')).toBe('ok');
  expect(queue.answer(id, 'Blue')).toBe('already');
  expect(queue.answer('nope', 'x')).toBe('unknown');
});
it('two concurrent waits both resolve with the same answer', async () => {
  const queue = new QuestionQueue();
  const { id } = queue.ask(q());
  const a = queue.wait(id, 5000), b = queue.wait(id, 5000);
  queue.answer(id, 'Red');
  expect(await a).toEqual({ answered: true, answer: 'Red' });
  expect(await b).toEqual({ answered: true, answer: 'Red' });
});
it("dropFrom removes a dead session's questions and tells the waiters the question is gone", async () => {
  const queue = new QuestionQueue();
  const { id } = queue.ask(q('dead-job'));
  const keep = queue.ask(q('live-job'));
  const waiting = queue.wait(id, 5000);
  queue.dropFrom('dead-job');
  expect(await waiting).toEqual({ answered: false, gone: true });
  expect(queue.pending().map((x) => x.id)).toEqual([keep.id]);
  expect(queue.answer(id, 'late')).toBe('unknown');
});
it('an unknown id is gone for a waiter', async () => {
  expect(await new QuestionQueue().wait('nope', 10)).toEqual({ answered: false, gone: true });
});
it('notifies listeners on ask, answer and drop', () => {
  const queue = new QuestionQueue();
  const cb = vi.fn();
  queue.onChange(cb);
  const { id } = queue.ask(q());
  queue.answer(id, 'Red');
  queue.ask(q('x-job'));
  queue.dropFrom('x-job');
  expect(cb).toHaveBeenCalledTimes(4);
});
it('knows which sessions still have an open question', () => {
  const queue = new QuestionQueue();
  const a = queue.ask(q('fix-login'));
  queue.ask(q('fix-login'));
  expect(queue.hasPending('fix-login')).toBe(true);
  queue.answer(a.id, 'x');
  expect(queue.hasPending('fix-login')).toBe(true);
  expect(queue.hasPending('other-job')).toBe(false);
});

it('a permission question only accepts "allow" or "deny"', () => {
  const queue = new QuestionQueue();
  const { id } = queue.ask({ from: 'fix-login', text: 'Bash needs approval', kind: 'permission', tool: 'Bash', detail: 'git push' });
  expect(queue.pending()[0]).toMatchObject({ kind: 'permission', tool: 'Bash', detail: 'git push', options: ['allow', 'deny'] });
  expect(queue.answer(id, 'maybe')).toBe('invalid');
  expect(queue.answer(id, 'allow')).toBe('ok');
});
it('a plain question is of kind "question"', () => {
  expect(new QuestionQueue().ask({ from: 'x-job', text: 'Q?' }) && true).toBe(true);
  const queue = new QuestionQueue();
  queue.ask({ from: 'x-job', text: 'Q?' });
  expect(queue.pending()[0]!.kind).toBe('question');
});

// ---- console decisions and confirmations (Phase 4) ----
it('a decision item carries its payload and only accepts one of its own options', () => {
  const queue = new QuestionQueue();
  const seen: string[] = [];
  const { id } = queue.ask({ from: 'console', text: 'Ticket x needs you', kind: 'decision', options: ['send_back', 'approve', 'leave'], payload: { ticket: 'x', notes: [{ text: 'bug' }] } }, (a) => seen.push(a));
  expect(queue.pending()[0]).toMatchObject({ id, kind: 'decision', options: ['send_back', 'approve', 'leave'], payload: { ticket: 'x' } });
  expect(queue.answer(id, 'merge it now')).toBe('invalid');
  expect(queue.pending()).toHaveLength(1);
  expect(queue.answer(id, 'send_back')).toBe('ok');
  expect(seen).toEqual(['send_back']);
  expect(queue.answer(id, 'approve')).toBe('already');
  expect(seen).toEqual(['send_back']);
});
it('a confirm item only knows approve and reject', () => {
  const queue = new QuestionQueue();
  const seen: string[] = [];
  const { id } = queue.ask({ from: 'console', text: 'Release?', kind: 'confirm', payload: { tickets: ['a'] }, options: ['whatever'] }, (a) => seen.push(a));
  expect(queue.pending()[0]!.options).toEqual(['approve', 'reject']);
  expect(queue.answer(id, 'yes please')).toBe('invalid');
  expect(queue.answer(id, 'approve')).toBe('ok');
  expect(seen).toEqual(['approve']);
});
it('an answer handler that throws does not break the answer', () => {
  const queue = new QuestionQueue();
  const { id } = queue.ask({ from: 'console', text: 'Release?', kind: 'confirm' }, () => { throw new Error('boom'); });
  expect(queue.answer(id, 'reject')).toBe('ok');
  expect(queue.pending()).toEqual([]);
});
it('console items are not dropped when an agent exits, and do not make an agent wait for the user', () => {
  const queue = new QuestionQueue();
  queue.ask({ from: 'console', text: 'Release?', kind: 'confirm' });
  queue.dropFrom('fix-login');
  expect(queue.pending()).toHaveLength(1);
  expect(queue.hasPending('fix-login')).toBe(false);
});
it('a payload is kept as plain data and cut when it is absurdly large', () => {
  const queue = new QuestionQueue();
  const { id } = queue.ask({ from: 'console', text: 't', kind: 'decision', options: ['leave'], payload: { big: 'x'.repeat(500_000) } });
  expect(JSON.stringify(queue.pending().find((p) => p.id === id)!.payload).length).toBeLessThan(200_000);
});
it('questions and permissions behave as before', () => {
  const queue = new QuestionQueue();
  const { id } = queue.ask({ from: 'a-agent', text: 'Which color?', options: ['Red'] });
  expect(queue.pending()[0]!.kind).toBe('question');
  expect(queue.answer(id, 'anything goes')).toBe('ok');
});

it('console items belong to a source no agent or plan can be called, so no turn of any session drops them (review finding)', async () => {
  const { CONSOLE_FROM } = await import('../src/server/questions/queue');
  expect(CONSOLE_FROM).toBe('@console');
  expect(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(CONSOLE_FROM)).toBe(false); // not a valid slug
  const queue = new QuestionQueue();
  queue.ask({ from: CONSOLE_FROM, text: 'Release?', kind: 'confirm' });
  for (const slug of ['console', 'main', 'shop-api']) queue.dropFrom(slug);
  expect(queue.pending()).toHaveLength(1);
});
