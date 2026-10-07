import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute } from 'node:path';
import type { ProjectTab } from '../shared/protocol';
import type { Context, HostContext } from './http';
import { fail, readBody, send } from './http-util';

/** What `POST /api/projects` accepts (SPEC 5.1): a folder, optionally a name, a template and the project's commands. */
export interface AddProjectOptions {
  root: string;
  name?: string;
  templateId?: string;
  create?: boolean;
  /** The console picks the template and the commands from what the folder contains (the new-project dialog only asks for the folder). */
  auto?: boolean;
  build?: string;
  test?: string;
  lint?: string;
}

/** A refusal with a user-facing code (`error.<code>` in every language). */
export class ProjectError extends Error {
  constructor(readonly code: string, readonly httpStatus: number, readonly params?: Record<string, string | number>) {
    super(code);
  }
}

/** The console-wide list of projects, reached from every project's Context (the host owns the runtimes). */
export interface ProjectsApi {
  list(): ProjectTab[];
  /** The context of every open project, in the order they were opened (the first one answers requests with no `?project=`). */
  contexts(): Context[];
  add(o: AddProjectOptions): Promise<{ name: string }>;
  /** `purge`: also takes the project back to "never opened" (worktrees, its branches, `.andromedacli`). */
  close(name: string, purge?: boolean): Promise<void>;
}

/** A project name: what `projectNameFromDir` makes (lowercase ASCII and dashes, 3 to 40 characters). */
export const PROJECT_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;

const optString = (v: unknown): string | undefined | null => (v === undefined ? undefined : typeof v === 'string' && v.length <= 500 && !/[\r\n]/.test(v) ? v : null);

/** The project-independent routes: `POST /api/projects` and `DELETE /api/projects/<name>` (the token was checked by the caller). */
export async function handleProjectsRoute(host: Pick<HostContext, 'projects' | 'ensurePrereq'>, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const projects = host.projects;
  if (req.method === 'POST' && path === '/api/projects') {
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
    if (b.auto !== undefined && typeof b.auto !== 'boolean') return fail(res, 400, 'bad_request');
    if (!isAbsolute(b.root.trim())) return fail(res, 422, 'project.badRoot');
    // Same rule as an agent: nothing starts while a required prerequisite is not ok (unknown is never ok).
    const blocked = (await host.ensurePrereq()).find((c) => c.required && c.status !== 'ok');
    if (blocked) return fail(res, 422, 'prereq.blocked', { tool: blocked.id });
    try {
      const out = await projects.add({
        root: b.root.trim(), ...(b.name !== undefined && b.name !== '' ? { name: b.name } : {}),
        ...(b.templateId !== undefined && b.templateId !== '' ? { templateId: b.templateId } : {}), ...(b.create === true ? { create: true } : {}), ...(b.auto === true ? { auto: true } : {}),
        ...(build !== undefined ? { build } : {}), ...(test !== undefined ? { test } : {}), ...(lint !== undefined ? { lint } : {}),
      });
      return send(res, 201, out);
    } catch (e) {
      if (e instanceof ProjectError) return fail(res, e.httpStatus, e.code, e.params);
      return fail(res, 500, 'internal');
    }
  }
  const one = /^\/api\/projects\/([^/]+)$/.exec(path);
  if (req.method === 'DELETE' && one) {
    let name: string;
    try { name = decodeURIComponent(one[1]!); } catch { return fail(res, 400, 'bad_request'); }
    try {
      await projects.close(name, new URL(req.url ?? '/', 'http://x').searchParams.get('purge') === '1');
      return send(res, 200, { name });
    } catch (e) {
      if (e instanceof ProjectError) return fail(res, e.httpStatus, e.code, e.params);
      return fail(res, 500, 'internal');
    }
  }
  return fail(res, 404, 'not_found');
}
