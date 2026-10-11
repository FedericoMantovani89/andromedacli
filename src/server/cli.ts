import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parseCliArgs, projectNameFromDir } from './cli-args';
import { configDir } from './config';
import { startServer } from './index';
import { runDoctor } from './prereq/doctor';
import { errorMessage } from '../shared/guards';

function openBrowser(url: string): void {
  // `start` is a cmd.exe builtin; the empty string is the window title. Failure to open is not fatal.
  const child = spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

async function main(): Promise<void> {
  let args;
  try {
    args = parseCliArgs(process.argv.slice(2), process.cwd());
  } catch (e) {
    console.error(`console: ${errorMessage(e)}`);
    process.exit(2);
  }

  if (args.command === 'doctor') {
    const report = await runDoctor({ configDir: configDir(), projectRoot: resolve(args.projectRoot) });
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const c of report.checks) {
        console.log(`[${c.status}] ${c.id}${c.detail ? ` - ${c.detail}` : ''}`);
        if (c.fix && c.status !== 'ok') console.log(`       fix: ${c.fix}`);
      }
      console.log(report.ok ? 'doctor: all good' : 'doctor: problems found');
    }
    process.exit(report.ok ? 0 : 1);
  }

  // Only an explicit --project-root opens a folder; otherwise the remembered projects open, or the welcome screen asks for a project.
  const projectRoot = args.projectRootGiven ? resolve(args.projectRoot) : undefined;
  try {
    const server = await startServer({
      port: args.port, configDir: configDir(), ...(projectRoot ? { projectRoot, projectName: projectNameFromDir(projectRoot) } : {}),
    });
    const link = `${server.url}/?token=${server.token}`;
    console.log(`Console: ${link}`);
    if (projectRoot) console.log(`Project folder: ${projectRoot} (state in ${join(projectRoot, '.andromedacli')})`);
    if (!args.noOpen) openBrowser(link);
    const stop = () => { void server.close().then(() => process.exit(0)); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(`console: port ${args.port} is already in use (the port is fixed because the token is part of the URL; use --port)`);
      process.exit(2);
    }
    console.error(`console: ${errorMessage(e)}`);
    process.exit(1);
  }
}

void main();
