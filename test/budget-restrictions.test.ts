import { expect, it } from 'vitest';
import { Restrictions } from '../src/server/budget/restrictions';

it('holds one restriction per session and clears it', () => {
  const r = new Restrictions();
  expect(r.get('fix-login')).toBeUndefined();
  r.set('fix-login', { reason: 'budget' });
  expect(r.get('fix-login')).toEqual({ reason: 'budget' });
  expect(r.get('other')).toBeUndefined();
  r.clear('fix-login');
  expect(r.get('fix-login')).toBeUndefined();
});

it('a budget restriction is never replaced by a limit or a loop one; limit beats loop', () => {
  const r = new Restrictions();
  r.set('a', { reason: 'budget' });
  r.set('a', { reason: 'limit' });
  r.set('a', { reason: 'loop', signature: 'Bash:x' });
  expect(r.get('a')).toEqual({ reason: 'budget' });

  r.set('b', { reason: 'loop', signature: 'Bash:x' });
  r.set('b', { reason: 'limit' });
  expect(r.get('b')).toEqual({ reason: 'limit' });
  r.set('b', { reason: 'loop', signature: 'Bash:y' });
  expect(r.get('b')).toEqual({ reason: 'limit' });
  r.set('b', { reason: 'budget' });
  expect(r.get('b')).toEqual({ reason: 'budget' });
});

it('a new loop restriction replaces an older loop one (the latest repeated call)', () => {
  const r = new Restrictions();
  r.set('a', { reason: 'loop', signature: 'Bash:x' });
  r.set('a', { reason: 'loop', signature: 'Bash:y' });
  expect(r.get('a')).toEqual({ reason: 'loop', signature: 'Bash:y' });
});
