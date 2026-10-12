# Development

```bash
npx vitest run test/slug.test.ts   # locally run only the tests of what you changed
npm run test:changed          # check, then the tests related to your diff against origin/main (commits not pushed yet and uncommitted changes)
npm run test:ticket           # the same against project/<name>: what the console runs for an agent's ticket (it selects every file when that branch is far behind main)
npm run test:smoke            # check, then a fixed set of seven files (server, merge, spawn, pty, worktree, v1, i18n)
npm test                      # the full suite (10-15 minutes): it runs on GitHub (.github/workflows/ci.yml) on every push to main and pull request
npm run check                 # i18n parity, no literal UI text, no stray .focus(), then tsc
npm run build                 # bundles the UI into dist/ui
npm run shot -- --tab git     # a screenshot of the real UI from a throw-away console
npm run shot:readme            # regenerates the README pictures in assets/screenshots from a staged demo project
npm run hooks                 # installs the pre-commit hook (check, and a CHANGELOG line for a product change)
npx tsx test/e2e/phase6.spec.ts   # browser acceptance in Edge (fake agents, no quota used)
```

`test:changed` and `test:ticket` pick the test files that import what the diff touches. A diff that touches `package.json` or the vitest config selects every file (vitest's own rule: a dependency or the runner changed), so those two scripts only narrow the run for a change to sources and tests.

Rules worth knowing before a change: all code, comments and docs are in English; UI code contains only translation keys; missing data is shown as "n/a", never as zero; `.focus()` may only be called in `src/ui/focus.ts`. Changes to behaviour get a line in [CHANGELOG.md](../CHANGELOG.md).
