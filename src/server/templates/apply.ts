// Stub left by Phase 6C so that POST /api/plans typechecks; Phase 6D owns this file and its version replaces this one.
export type ApplyResult = { ok: true } | { ok: false; code: string; detail?: string };

export async function applyTemplate(_o: { templateId: string; root: string; name: string; create: boolean; build?: string; test?: string; lint?: string; configDir: string }): Promise<ApplyResult> {
  return { ok: false, code: 'template.notFound' };
}
