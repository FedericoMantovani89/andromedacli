import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute } from 'node:path';
import type { PlanTab } from '../shared/protocol';
import type { Context, HostContext } from './http';
import { fail, readBody, send } from './http-util';

/** What `POST /api/plans` accepts (SPEC 5.1): a folder, optionally a name, a template and the project's commands. */
export interface AddPlanOptions {
  root: string;
  name?: string;
  templateId?: string;
  create?: boolean;
  build?: string;
  test?: string;
  lint?: string;
}

/** A refusal with a user-facing code (`error.<code>` in every language). */
export class PlanError extends Error {
  constructor(readonly code: string, readonly httpStatus: number, readonly params?: Record<string, string | number>) {
    super(code);
  }
}

/** The console-wide list of plans, reached from every plan's Context (the host owns the runtimes). */
export interface PlansApi {
  list(): PlanTab[];
  /** The context of every open plan, in the order they were opened (the first one answers requests with no `?plan=`). */
  contexts(): Context[];
  add(o: AddPlanOptions): Promise<{ name: string }>;
  close(name: string): Promise<void>;
}

/** A plan name: what `planNameFromDir` makes (lowercase ASCII and dashes, 3 to 40 characters). */
export const PLAN_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;

const optString = (v: unknown): string | undefined | null => (v === undefined ? undefined : typeof v === 'string' && v.length <= 500 && !/[\r\n]/.test(v) ? v : null);

/** The plan-independent routes: `POST /api/plans` and `DELETE /api/plans/<name>` (the token was checked by the caller). */
export async function handlePlansRoute(host: Pick<HostContext, 'plans' | 'ensurePrereq'>, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const plans = host.plans;
  if (req.method === 'POST' && path === '/api/plans') {
    let body: unknown;
    try { body = await readBody(req); } catch { return fail(res, 400, 'bad_request'); }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail(res, 400, 'bad_request');
    const b = body as Record<string, unknown>;
    if (typeof b.root !== 'string' || b.root.trim() === '') return fail(res, 400, 'bad_request');
    const build = optString(b.build), test = optString(b.test), lint = optString(b.lint);
    if (build === null || test === null || lint === null) return fail(res, 400, 'bad_request');
    if (b.name !== undefined && typeof b.name !== 'string') return fail(res, 400, 'bad_request');
    if (b.templateId !== undefined && typeof b.templateId !== 'string') return fail(res, 400, 'bad_request');
    if (b.create !== undefined && typeof b.create !== 'boolean') return fail(res, 400, 'bad_request');
    if (!isAbsolute(b.root.trim())) return fail(res, 422, 'plan.badRoot');
    // Same rule as an agent: nothing starts while a required prerequisite is not ok (unknown is never ok).
    const blocked = (await host.ensurePrereq()).find((c) => c.required && c.status !== 'ok');
    if (blocked) return fail(res, 422, 'prereq.blocked', { tool: blocked.id });
    try {
      const out = await plans.add({
        root: b.root.trim(), ...(b.name !== undefined && b.name !== '' ? { name: b.name } : {}),
        ...(b.templateId !== undefined && b.templateId !== '' ? { templateId: b.templateId } : {}), ...(b.create === true ? { create: true } : {}),
        ...(build !== undefined ? { build } : {}), ...(test !== undefined ? { test } : {}), ...(lint !== undefined ? { lint } : {}),
      });
      return send(res, 201, out);
    } catch (e) {
      if (e instanceof PlanError) return fail(res, e.httpStatus, e.code, e.params);
      return fail(res, 500, 'internal');
    }
  }
  const one = /^\/api\/plans\/([^/]+)$/.exec(path);
  if (req.method === 'DELETE' && one) {
    let name: string;
    try { name = decodeURIComponent(one[1]!); } catch { return fail(res, 400, 'bad_request'); }
    try {
      await plans.close(name);
      return send(res, 200, { name });
    } catch (e) {
      if (e instanceof PlanError) return fail(res, e.httpStatus, e.code, e.params);
      return fail(res, 500, 'internal');
    }
  }
  return fail(res, 404, 'not_found');
}
