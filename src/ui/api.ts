const TOKEN_KEY = 'console.token';

/** The token arrives in the opening URL; keep it for this tab and remove it from the visible address. */
export function initToken(): string {
  const fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl) {
    try { sessionStorage.setItem(TOKEN_KEY, fromUrl); } catch { /* storage may be blocked */ }
    history.replaceState(null, '', location.pathname + location.hash); // the hash (`#queue=<id>`, from a notification) is read after the first state
    return fromUrl;
  }
  try { return sessionStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}

export const token = initToken();

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
  const res = await fetch(withProject(path), {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: body as T };
}

/** A terminal socket names its own project (it reconnects on its own, whatever tab is on screen by then). */
export function wsUrl(path: string, project: string | undefined = selectedProject): string {
  return `ws://${location.host}${path}?token=${encodeURIComponent(token)}${project !== undefined ? `&project=${encodeURIComponent(project)}` : ''}`;
}
