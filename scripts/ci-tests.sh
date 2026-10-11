#!/usr/bin/env bash
# The full suite on CI. On the Windows runner a worker of vitest sometimes dies on its own (exit code 3221225477, a native crash of
# node-pty while a terminal closes) with no test failing. Then, and only then, the files whose worker died run once more. A test that
# fails, or a crash that happens again, fails the job.
set +e
log="${TMPDIR:-/tmp}/vitest-run.log"
npx vitest run 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
[ "$code" -eq 0 ] && exit 0

if grep -q "Worker exited unexpectedly" "$log" && ! grep -qE "(^| )FAIL " "$log"; then
  files=$(grep "Worker exited unexpectedly" "$log" | grep -oE "test/[A-Za-z0-9._-]+\.test\.ts" | sort -u | tr '\n' ' ')
  if [ -n "$files" ]; then
    echo "::warning::a vitest worker crashed with no test failing; running once more: $files"
    # shellcheck disable=SC2086
    npx vitest run $files
    exit $?
  fi
fi
exit "$code"
