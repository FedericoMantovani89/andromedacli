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

export interface ApiResult<T> { status: number; body: T }

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: body as T };
}

export function wsUrl(path: string): string {
  return `ws://${location.host}${path}?token=${encodeURIComponent(token)}`;
}
