#!/usr/bin/env bash
# The full suite on CI. On the Windows runner a worker of vitest sometimes dies on its own (exit code 3221225477, a native crash of
# node-pty while a terminal closes) with no test failing. Then, and only then, the whole suite runs once more (a crash can leave
# other files unrun, and the format of the crash report is vitest's, so no file list is parsed). A test that fails, or a crash that
# happens again, fails the job.
set +e
log=$(mktemp)
trap 'rm -f "$log"' EXIT
npx vitest run 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
[ "$code" -eq 0 ] && exit 0

# "Tests  3 failed | 40 passed" is the summary of real test failures; a crashed worker is reported as an error, not as a failed test.
if grep -q "Worker exited unexpectedly" "$log" && ! grep -qE "^ *Tests +.*[0-9]+ failed" "$log"; then
  echo "::warning::a vitest worker crashed with no test failing; running the suite once more"
  npx vitest run
  exit $?
fi
exit "$code"
