# Changelog

All notable changes to this project are recorded here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project is not versioned yet, so entries are grouped by
the phases of `docs/SPEC.md` section 24. Write entries in English (P11) and add them in the same change that
introduces the behaviour.

## [Unreleased]

Next: Phase 2, the mod and the HTTP channel between Claude Code sessions and the console.

## Phase 1: console base (2026-10-04)

### Added
- Local console server on `127.0.0.1` (default port 7391) with a per-start token and Host/Origin checks; it owns every
  `claude` process through node-pty (ConPTY) and keeps a per-session scrollback that survives closing the browser tab.
- Browser UI (xterm.js): fixed main on the left, agents stacked on the right (full panels up to four, then bars),
  manual agent launch, status bar, `Alt+1..9` shortcuts. The keyboard focus never moves on its own.
- Activity-name (slug) rules: format, length, generic names, Windows reserved names, uniqueness, accents transliterated.
- Plan state under `<repo>/.console/` (`plan.json`, `state/agents.json`); the plan keeps its original name.
- Internationalisation through `.properties` bundles (`en`, `it`); languages are discovered from the files and can be
  switched at runtime without reloading.
- Build gate `npm run check`: key/placeholder parity between languages, unused and undefined keys, user-facing error
  codes have a text, no literal visible strings or stray `.focus()` in the UI, `tsc`.
- Read-only prerequisite checks (Node >= 22, Git, Claude Code >= 2.1.287, honouring the configured Claude command), a
  skippable first-start wizard, a settings dialog and `console doctor [--json]` with a live security self-test.
- Tests: unit and integration (Vitest), browser acceptance in Edge (`test/e2e/phase1.spec.ts`) and a manual smoke test
  with the real Claude Code (`test/e2e/real-claude-smoke.ts`).

### Changed
- Sessions start without `--dangerously-skip-permissions` until the guard of Phase 3 exists
  (`agents.bypassPermissions`, default `false`).
- `GET /i18n/<lang>` is served without the token (Host check still applies) so a refused token can be explained.

### Fixed
- Closing a ConPTY that runs the real Claude Code blocked Node for about a minute; the process tree is now ended with
  `taskkill /T /F` first.
- Scrollback buffer copied 4 MiB per output chunk and lost terminal modes (bracketed paste, cursor) after wrapping.
- A state update could move the node the user was typing in and drop its focus; panels and bars are now reconciled and
  cached instead of rebuilt.
- Agents saved by an earlier run no longer occupy panel slots; a failed agent creation leaves no orphan process.
- Saving the language never overwrites a hand-edited or unreadable `config.json`.
- Agent creation waits for the startup prerequisite checks instead of proceeding while they are unknown.
- A corrupt `agents.json` or a malformed WebSocket request no longer crashes the server.
- Keys typed behind the first-start wizard no longer reach a hidden terminal; a refused token shows a message instead of
  a blank page; the queue shows n/a and the agent count excludes the main session.

## Phase 0: verification of the Claude Code mods (2026-10-04)

Documentation only, kept under `docs/` (not versioned): `REPORT-VERIFICHE.md` with the outcome of checks V1-V19, the study
of context compaction (S0), notes on the reference projects, and a probe mod. No plan B was needed for V1-V8. See
`docs/SPEC.md` section 3.5 for the places where reality differed from the specification.
