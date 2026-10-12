const TOKEN_KEY = 'console.token';

/**
 * The page opens with a single-use code in its address (`?code=`): it is swapped once for the token, which this tab keeps in
 * sessionStorage (per address, so another local server never sees it), and the code leaves the visible address. Tools that already hold
 * the token (the test runs, `npm run shot`) may still pass `?token=`.
 */
async function initToken(): Promise<string> {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const legacy = params.get('token');
  let fresh: string | undefined;
  if (code) {
    try {
      const res = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
      if (res.status === 200) fresh = ((await res.json()) as { token?: string }).token;
    } catch { /* the server is not there: the page explains it */ }
  } else if (legacy) fresh = legacy;
  if (code || legacy) {
    params.delete('code');
    params.delete('token');
    const rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash); // the hash (`#queue=<id>`, from a notification) is read after the first state
  }
  if (fresh) {
    try { sessionStorage.setItem(TOKEN_KEY, fresh); } catch { /* storage may be blocked */ }
    return fresh;
  }
  try { return sessionStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}

/** The token of this page; read it only after `ready` has settled. */
export let token = '';
/** Settles when the opening address has been dealt with: the page waits for it before its first request. */
export const ready: Promise<void> = initToken().then((t) => { token = t; });

const PROJECT_KEY = 'console.project';

/** The project on screen: every request and socket of the page names it (`?project=`); undefined means the first project. */
let selectedProject: string | undefined = (() => {
  try { return sessionStorage.getItem(PROJECT_KEY) ?? undefined; } catch { return undefined; }
})();

export const getSelectedProject = (): string | undefined => selectedProject;

export function setSelectedProject(name: string | undefined): void {
  selectedProject = name;
  try {
    if (name === undefined) sessionStorage.removeItem(PROJECT_KEY);
    else sessionStorage.setItem(PROJECT_KEY, name);
  } catch { /* storage may be blocked: the selection is just not remembered */ }
}

/** Adds `project=<selected>` to a path, except on the routes that are not about one project. */
function withProject(path: string): string {
  if (selectedProject === undefined || path.startsWith('/api/projects')) return path;
  return `${path}${path.includes('?') ? '&' : '?'}project=${encodeURIComponent(selectedProject)}`;
}

export interface ApiResult<T> { status: number; body: T }

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  await ready;
  const res = await fetch(withProject(path), {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: body as T };
}

/** A terminal socket names its own project (it reconnects on its own, whatever tab is on screen by then). Needs `ready` to have settled. */
export function wsUrl(path: string, project: string | undefined = selectedProject): string {
  return `ws://${location.host}${path}?token=${encodeURIComponent(token)}${project !== undefined ? `&project=${encodeURIComponent(project)}` : ''}`;
}
