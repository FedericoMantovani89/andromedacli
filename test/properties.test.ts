import { it, expect } from 'vitest';
import { parseProperties } from '../src/server/properties';

it('parses key=value, skips comments and blanks, keeps = inside values', () => {
  const r = parseProperties('# c\n\nstatus.working=Working\nerror.x=a=b  \n  queue.title = Queue ({count})\n');
  expect(r).toEqual({ 'status.working': 'Working', 'error.x': 'a=b', 'queue.title': 'Queue ({count})' });
});
it('handles CRLF, BOM and \\n escapes', () => {
  expect(parseProperties('﻿a=1\r\nb=x\\ny\r\n')).toEqual({ a: '1', b: 'x\ny' });
});
it('rejects duplicate keys', () => {
  expect(() => parseProperties('a=1\na=2')).toThrow(/duplicate key "a"/);
});
it('rejects a line without =', () => {
  expect(() => parseProperties('oops')).toThrow(/line 1/);
});
