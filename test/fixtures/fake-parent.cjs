// Stand-in for a CLI that starts child processes (like claude): prints its child's pid and idles.
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
process.stdout.write('CHILD ' + child.pid + '\r\n');
setInterval(() => {}, 1000);
