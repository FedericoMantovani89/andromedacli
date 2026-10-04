export interface LaunchOptions {
  command: string[]; role: 'main' | 'agent'; slug: string; plan: string;
  /** For a launched session this is its own session token (never the UI token). */
  url: string; token: string; bypass: boolean; baseEnv: NodeJS.ProcessEnv; platform?: NodeJS.Platform;
  /** The console mod to load (--plugin-dir). Omitted: no mod (fake agents in tests, or mod disabled). */
  pluginDir?: string;
  /** Text appended to the system prompt (profile, main instructions). */
  appendPromptFile?: string;
  /** Model alias or id (--model). Omitted: Claude Code's default. */
  model?: string;
  /** Tools approved without a permission prompt (the console's own tools). */
  allowedTools?: string[];
}

/** Windows paths go through cmd.exe and node-pty: forward slashes survive both. */
const fwd = (p: string): string => p.replace(/\\/g, '/');

// Phase 0: an inherited CLAUDE_CODE_CHILD_SESSION marker turns transcript saving off in the child.
const STRIP = /^CLAUDE_CODE_|^CLAUDECODE$|^CLAUDE_PID$/;

export function buildClaudeLaunch(o: LaunchOptions): { file: string; args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.baseEnv)) {
    if (v !== undefined && !STRIP.test(k)) env[k] = v;
  }
  env.CONSOLE_URL = o.url;
  env.CONSOLE_TOKEN = o.token;
  env.CONSOLE_ROLE = o.role;
  env.CONSOLE_AGENT = o.slug;
  const [cmd, ...rest] = o.command;
  const flags = [
    ...(o.model ? ['--model', o.model] : []),
    ...(o.pluginDir ? ['--plugin-dir', fwd(o.pluginDir)] : []),
    ...(o.appendPromptFile ? ['--append-system-prompt-file', fwd(o.appendPromptFile)] : []),
    ...(o.allowedTools && o.allowedTools.length > 0 ? ['--allowedTools', o.allowedTools.join(',')] : []),
    ...(o.bypass ? ['--dangerously-skip-permissions'] : []),
  ];
  const bareName = !/[\\/]/.test(cmd!) && !/\.exe$/i.test(cmd!);
  if ((o.platform ?? process.platform) === 'win32' && bareName) {
    // A bare `claude` resolves through a .cmd shim on Windows: go through cmd.exe (proven in Phase 0).
    // node-pty only quotes arguments that contain whitespace, so cmd.exe would read & | < > ^ % in the others as commands.
    for (const a of [cmd!, ...rest, ...flags]) {
      if (/[&|<>^%"]/.test(a) || a.includes(String.fromCharCode(10)) || a.includes(String.fromCharCode(13))) throw new Error(`unsafe argument for cmd.exe: ${JSON.stringify(a)}`);
    }
    return { file: 'cmd.exe', args: ['/c', cmd!, ...rest, ...flags], env };
  }
  return { file: cmd!, args: [...rest, ...flags], env };
}
