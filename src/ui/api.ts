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

const PLAN_KEY = 'console.plan';

/** The plan on screen: every request and socket of the page names it (`?plan=`); undefined means the first plan. */
let selectedPlan: string | undefined = (() => {
  try { return sessionStorage.getItem(PLAN_KEY) ?? undefined; } catch { return undefined; }
})();

export const getSelectedPlan = (): string | undefined => selectedPlan;

export function setSelectedPlan(name: string | undefined): void {
  selectedPlan = name;
  try {
    if (name === undefined) sessionStorage.removeItem(PLAN_KEY);
    else sessionStorage.setItem(PLAN_KEY, name);
  } catch { /* storage may be blocked: the selection is just not remembered */ }
}

/** Adds `plan=<selected>` to a path, except on the routes that are not about one plan. */
function withPlan(path: string): string {
  if (selectedPlan === undefined || path.startsWith('/api/plans')) return path;
  return `${path}${path.includes('?') ? '&' : '?'}plan=${encodeURIComponent(selectedPlan)}`;
}

export interface ApiResult<T> { status: number; body: T }

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  const res = await fetch(withPlan(path), {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: body as T };
}

/** A terminal socket names its own plan (it reconnects on its own, whatever tab is on screen by then). */
export function wsUrl(path: string, plan: string | undefined = selectedPlan): string {
  return `ws://${location.host}${path}?token=${encodeURIComponent(token)}${plan !== undefined ? `&plan=${encodeURIComponent(plan)}` : ''}`;
}
