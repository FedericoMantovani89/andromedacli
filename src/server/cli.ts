import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parseCliArgs, planNameFromDir } from './cli-args';
import { configDir } from './config';
import { startServer } from './index';
import { runDoctor } from './prereq/doctor';

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
    console.error(`console: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  if (args.command === 'doctor') {
    const report = await runDoctor({ configDir: configDir(), planRoot: resolve(args.planRoot) });
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

  const planRoot = resolve(args.planRoot);
  try {
    const server = await startServer({
      port: args.port, planRoot, configDir: configDir(), planName: planNameFromDir(planRoot),
    });
    const link = `${server.url}/?token=${server.token}`;
    console.log(`Console: ${link}`);
    console.log(`Plan folder: ${planRoot} (state in ${join(planRoot, '.console')})`);
    if (!args.noOpen) openBrowser(link);
    const stop = () => { void server.close().then(() => process.exit(0)); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(`console: port ${args.port} is already in use (the port is fixed because the token is part of the URL; use --port)`);
      process.exit(2);
    }
    console.error(`console: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

void main();
