// @vitest-environment node
import { it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { renderMarkdown } from '../src/ui/markdown';

// The same sanitiser the browser uses, run in Node on a jsdom window.
const purify = createDOMPurify(new JSDOM('').window as unknown as Window & typeof globalThis);
const render = (md: string) => renderMarkdown(md, purify);

it('renders normal Markdown: headings, lists, code, tables, emphasis', () => {
  const html = render('## Title\n\n- one\n- two\n\n`code` and **bold**\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
  expect(html).toContain('<h2>Title</h2>');
  expect(html).toContain('<li>one</li>');
  expect(html).toContain('<code>code</code>');
  expect(html).toContain('<strong>bold</strong>');
  expect(html).toContain('<table>');
});
it('removes script tags and their content', () => {
  const html = render('hello <script>window.pwned = 1</script> world');
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toContain('pwned');
});
it('removes event-handler attributes from raw HTML in the answer', () => {
  const html = render('<img src=x onerror="window.pwned=1"> <b onclick="x()">b</b>');
  expect(html).not.toMatch(/onerror|onclick/i);
});
it('neutralises javascript: links but keeps ordinary ones', () => {
  const bad = render('[click](javascript:alert(1))');
  expect(bad).not.toMatch(/javascript:/i);
  const good = render('[docs](https://example.com/a)');
  expect(good).toContain('href="https://example.com/a"');
});
it('forces safe attributes on links: new tab, no opener', () => {
  const html = render('[docs](https://example.com)');
  expect(html).toContain('target="_blank"');
  expect(html).toMatch(/rel="[^"]*noopener[^"]*"/);
  expect(html).toMatch(/rel="[^"]*noreferrer[^"]*"/);
});
it('drops iframes, forms, styles, objects and inline SVG scripts', () => {
  const html = render('<iframe src="https://evil"></iframe><form action="x"><input></form><style>body{display:none}</style><object data="x"></object><svg><script>1</script></svg>');
  expect(html).not.toMatch(/<(iframe|form|input|style|object|script)/i);
});
it('survives an enormous or odd input without throwing', () => {
  expect(() => render('x'.repeat(300_000))).not.toThrow();
  expect(() => render('<<<>>>&&&&')).not.toThrow();
  expect(render('')).toBe('');
});
