import { existsSync } from 'node:fs';
import { AgentRegistry } from '../agents/registry';
import { defaultProjectsDir, transcriptPath } from '../budget/transcript';
import { discoverRepos } from '../git/repos';
import { excludeConsoleFolder } from '../git/worktree';
import { installReleaseHook } from '../git/release-hook';
import { SESSION_ID_RE } from '../pty/claude-launch';
import { PtyManager } from '../pty/pty-manager';
import { SessionTokens } from '../security';
import type { ProjectContainer } from './services';

/** The services that own the agent sessions: the terminals, their tokens, the registry, the guard mode each session started under, and the repositories. */
export function registerAgents(c: ProjectContainer): void {
  c.provide('ptys', () => new PtyManager());
  c.provide('tokens', () => new SessionTokens());
  // The main's last session (state/main.json): the first launch resumes it, so the main keeps its context across a restart.
  // Claude Code keeps no transcript for a session that never got a prompt: resuming that id fails with "No conversation found", so such an id starts fresh.
  c.provide('mainResumeId', (k) => {
    const { o } = k.get('env');
    const store = k.get('store');
    const savedMainSession = store.readMainSession();
    const hasMainTranscript = (id: string): boolean => existsSync(transcriptPath(o.projectsDir ?? defaultProjectsDir(), o.projectRoot, id));
    const resumeId = savedMainSession !== undefined && SESSION_ID_RE.test(savedMainSession) && hasMainTranscript(savedMainSession) ? savedMainSession : undefined;
    return () => resumeId;
  });
  c.provide('registry', (k) => {
    const projectName = k.get('projectName');
    const mainResumeId = k.get('mainResumeId')();
    const registry = new AgentRegistry();
    registry.register({ slug: projectName, role: 'main', profile: 'main', ...(mainResumeId !== undefined ? { sessionId: mainResumeId } : {}) });
    return registry;
  });
  // The guard mode a session was launched under: a later change in Settings does not reach sessions already running.
  c.provide('sessionGuardMode', (k) => {
    const { config } = k.get('env');
    const projectName = k.get('projectName');
    return new Map<string, 'enforce' | 'shadow'>([[projectName, config.guard.mode]]);
  });
  c.provide('launchLog', () => new Map<string, string[]>());

  // The state is rebuilt on every push to the UI and discovery spawns git: a few seconds of memory is plenty (a repo made later shows up soon).
  let repoCache: { at: number; list: string[] } | undefined;
  const preparedRepos = new Set<string>();
  c.provide('repos', (k) => {
    const { o } = k.get('env');
    return (): string[] => {
      const now = Date.now();
      if (!repoCache || now - repoCache.at > 5000) repoCache = { at: now, list: discoverRepos(o.projectRoot) };
      return repoCache.list;
    };
  });
  c.provide('forgetRepos', () => (): void => { repoCache = undefined; });
  c.provide('prepareRepo', () => async (path: string): Promise<void> => {
    const key = path.replace(/\\/g, '/').toLowerCase();
    if (preparedRepos.has(key)) return;
    preparedRepos.add(key);
    // The console's own folder never shows in git status; nobody pushes main from here except the console, after the user approves a release (SPEC 9.1, 15.5).
    await excludeConsoleFolder(path).catch(() => { /* cosmetic: the first worktree tries again */ });
    await installReleaseHook(path).catch(() => 'skipped_existing');
  });
}
