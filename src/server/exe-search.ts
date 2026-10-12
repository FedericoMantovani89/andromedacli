/**
 * Windows looks for a program in the current folder before the PATH. The console starts `git` and `claude` with a project folder as the
 * working folder, so a `git.exe` or `claude.cmd` that a repository carries would run instead of the real one. With this variable set
 * in the console's own environment that search skips the current folder (checked on Windows with Node 24: setting it only in the
 * `env` option of `execFile` does not protect `git`; libuv reads it from the parent process). It changes no PATH and reads no registry.
 */
export function hardenExecutableSearch(): void {
  process.env.NoDefaultCurrentDirectoryInExePath = '1';
}
