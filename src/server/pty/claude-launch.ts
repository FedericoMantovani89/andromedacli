export interface LaunchOptions {
  command: string[]; role: 'main' | 'agent'; slug: string; plan: string;
  url: string; token: string; bypass: boolean; baseEnv: NodeJS.ProcessEnv; platform?: NodeJS.Platform;
}

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
  const flags = o.bypass ? ['--dangerously-skip-permissions'] : [];
  const bareName = !/[\\/]/.test(cmd!) && !/\.exe$/i.test(cmd!);
  if ((o.platform ?? process.platform) === 'win32' && bareName) {
    // A bare `claude` resolves through a .cmd shim on Windows: go through cmd.exe (proven in Phase 0).
    return { file: 'cmd.exe', args: ['/c', cmd!, ...rest, ...flags], env };
  }
  return { file: cmd!, args: [...rest, ...flags], env };
}
