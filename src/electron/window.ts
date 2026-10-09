/**
 * True only for the console's own origin (`http://127.0.0.1:<port>`): the window may show nothing else (SPEC 33.1). Anything else a page
 * asks for goes to the user's browser, never into this window, which can start and stop agents.
 */
export function isInternalUrl(url: string, port: number): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.username === '' && u.password === '' && Number(u.port) === port;
}
