# Contributing

Thanks for looking. This is a small project with a few firm rules; they keep the code and the interface consistent.

## Before you start

- Read [guide/architecture.md](guide/architecture.md) for the part you want to change, and [SECURITY.md](SECURITY.md) if you touch the guard, the server's authentication or git handling.
- For anything bigger than a fix, open an issue first so we can agree on the shape of it.

## The rules

- **English everywhere in the repository:** code, identifiers, comments, commit messages, logs and docs.
- **No visible text in UI code.** The interface only uses translation keys, always inside `k('...')`, defined in both `src/i18n/messages_en.properties` (the reference and the fallback) and `src/i18n/messages_it.properties`. A new language is just a new file. Internal codes (states, roles, error codes) are English constants that the UI translates (`error.<code>`); never display them directly.
- **Missing data is shown as "n/a"**, never as zero, and unknown is never "ok".
- **`.focus()` may only be called in `src/ui/focus.ts`.** Focus never moves on its own.
- **Agent state comes from structured events** (the mod), never from reading the terminal.
- **A behaviour change gets a line in [CHANGELOG.md](CHANGELOG.md)** under `[Unreleased]`, in the same change.

## Checks and tests

```bash
npm run check                          # texts, literals, focus, then tsc: the build gate
npx vitest run test/<file>.test.ts     # the tests of what you changed
npm run test:ticket                    # the tests related to your diff
npm run test:smoke                     # a fixed set of seven files
npm run hooks                          # installs the pre-commit hook (check, and a CHANGELOG line)
```

The full suite (`npm test`, 10-15 minutes, real node-pty children and real git) runs on GitHub for every pull request, on Windows. More in [guide/development.md](guide/development.md).

## Pull requests

- One topic per pull request, with the tests that show it works.
- A change to what the interface shows needs a look at the real thing: `npm run build`, then `npm run shot -- --tab <name>` makes a screenshot from a throw-away console.
- Windows is the supported platform today; changes that keep the code portable are welcome, but nothing here is tested elsewhere.
