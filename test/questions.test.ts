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
