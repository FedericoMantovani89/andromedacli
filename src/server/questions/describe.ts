/**
 * What a tool call would do, in a line a person can judge: the command, the file, or the arguments (cut short). The console builds it
 * from the input it will remember, so the line the user approves is the call that is remembered, not a text the client chose.
 */
export function describeInput(input: unknown): string {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const o = input as Record<string, unknown>;
    if (typeof o.command === 'string') return o.command;
    if (typeof o.file_path === 'string') return o.file_path;
    try { return JSON.stringify(input).slice(0, 2000); } catch { return ''; }
  }
  return '';
}

/** The description of a permission key (the whole input as JSON); undefined when the key is not the JSON of an object. */
export function describeKey(key: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(key);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? describeInput(parsed) : undefined;
  } catch {
    return undefined;
  }
}
