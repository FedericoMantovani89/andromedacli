import { expect, it } from 'vitest';
import { isInternalUrl } from '../src/electron/window';

it('only the console\'s own origin is internal', () => {
  expect(isInternalUrl('http://127.0.0.1:7391/?token=x', 7391)).toBe(true);
  expect(isInternalUrl('http://127.0.0.1:7391', 7391)).toBe(true);
});
it('another port, host or scheme is not', () => {
  for (const url of ['http://127.0.0.1:7392/', 'http://localhost:7391/', 'https://127.0.0.1:7391/', 'file:///c:/x', 'http://127.0.0.1.evil.com:7391/', 'http://user@127.0.0.1:7391@evil.com/', 'not a url', '']) {
    expect(isInternalUrl(url, 7391)).toBe(false);
  }
});
