import DOMPurify from 'dompurify';
import { marked } from 'marked';

type Purifier = Pick<typeof DOMPurify, 'sanitize' | 'addHook'>;

/** The text of an agent answer is untrusted: it may contain raw HTML. Only inert formatting survives. */
const SANITIZE = {
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'script', 'link', 'meta', 'img', 'svg', 'math'],
  FORBID_ATTR: ['style', 'srcset'],
  ALLOW_DATA_ATTR: false,
};

const configured = new WeakSet<object>();

/** Markdown -> sanitised HTML string (headings, lists, code, tables, links that open in a new tab without an opener). */
export function renderMarkdown(text: string, purify: Purifier = DOMPurify): string {
  if (!configured.has(purify)) {
    purify.addHook('afterSanitizeAttributes', (node) => {
      if (node.nodeName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
    configured.add(purify);
  }
  const html = marked.parse(text, { async: false, gfm: true }) as string;
  return purify.sanitize(html, SANITIZE) as string;
}
