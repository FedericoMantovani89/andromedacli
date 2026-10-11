/** A plain JSON object: not null, not an array. */
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The text of a caught value, whatever was thrown. */
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
