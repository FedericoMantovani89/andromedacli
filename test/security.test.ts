import { it, expect } from 'vitest';
import { createToken, tokensEqual, isAllowedHost, isAllowedOrigin, extractToken } from '../src/server/security';

it('creates distinct url-safe tokens of at least 32 chars', () => {
  const a = createToken(), b = createToken();
  expect(a).not.toBe(b);
  expect(a).toMatch(/^[A-Za-z0-9_-]{32,}$/);
});
it('compares tokens in constant time and tolerates different lengths', () => {
  expect(tokensEqual('abc', 'abc')).toBe(true);
  expect(tokensEqual('abc', 'abd')).toBe(false);
  expect(tokensEqual('abc', 'abcd')).toBe(false);
});
it('accepts only loopback Host headers on our port (DNS rebinding guard)', () => {
  expect(isAllowedHost('127.0.0.1:7391', 7391)).toBe(true);
  expect(isAllowedHost('localhost:7391', 7391)).toBe(true);
  expect(isAllowedHost('evil.example:7391', 7391)).toBe(false);
  expect(isAllowedHost('127.0.0.1:80', 7391)).toBe(false);
  expect(isAllowedHost(undefined, 7391)).toBe(false);
});
it('requires a loopback Origin for browsers and rejects foreign ones', () => {
  expect(isAllowedOrigin('http://127.0.0.1:7391', 7391)).toBe(true);
  expect(isAllowedOrigin('http://localhost:7391', 7391)).toBe(true);
  expect(isAllowedOrigin('https://evil.example', 7391)).toBe(false);
  expect(isAllowedOrigin('null', 7391)).toBe(false);
  expect(isAllowedOrigin(undefined, 7391)).toBe(false);
});
it('extracts the token from Authorization or the query string', () => {
  expect(extractToken({ authorization: 'Bearer T1' }, new URL('http://x/y'))).toBe('T1');
  expect(extractToken({}, new URL('http://x/y?token=T2'))).toBe('T2');
  expect(extractToken({}, new URL('http://x/y'))).toBeUndefined();
});
