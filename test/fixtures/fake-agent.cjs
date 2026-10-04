// Stand-in for `claude` in tests: prints READY, echoes typed lines, quits on "quit".
const slug = process.env.CONSOLE_AGENT || 'unknown';
const size = () => process.stdout.columns + 'x' + process.stdout.rows;
process.stdout.write(`READY ${slug} ${size()}\r\n`);
process.stdout.write(`CWD ${process.cwd()}\r\n`); // lets the tests see where the session was started

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let m;
  while ((m = /\r\n|\r|\n/.exec(buf))) {
    const line = buf.slice(0, m.index);
    buf = buf.slice(m.index + m[0].length);
    if (line === 'quit') process.exit(0);
    process.stdout.write(`ECHO:${line}\r\n`);
  }
});
