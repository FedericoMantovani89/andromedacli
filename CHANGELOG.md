# Changelog

All notable changes to this project are recorded here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project is not versioned yet, so entries are grouped by
the phases of `docs/SPEC.md` section 24. Write entries in English (P11) and add them in the same change that
introduces the behaviour.

## [Unreleased]

Next: Phase 4 (review and merge); ask before starting.

## Phase 3: git worktrees, checklists and guard (2026-10-04)

### Added
- Git worktrees: every agent gets its own worktree (`<repo>.worktrees/<name>`) on its own branch `agent/<plan>/<name>`,
  created from the plan branch `plan/<plan>` (made from HEAD the first time); the session starts inside it. A queued agent
  gets its worktree only when its slot arrives. Refused up front with `git.notRepo`, `git.noCommits`, `git.worktreeExists`;
  a failed start leaves no worktree, branch, hook folder, token or process. `git.worktrees: false` keeps the old behaviour.
- Per-worktree `pre-push` hook (through `extensions.worktreeConfig`, script kept in the repository's git dir): only the
  agent's own branch can be pushed; other refs, force, deletes and tags are refused.
- Checklists and tickets: tools `checklist_set`, `step_done`, `report_blocked` (agents only). The console validates the
  mandatory skeleton (study, tests first, steps, validation, documentation), commits each closed step itself
  (`step n/N: title`, trailers `Agent:`, `Ticket:`, `Piano:`), refuses secrets (`.env`, keys, credentials, configurable
  patterns), runs the plan's test command at the validation step with a timeout, and pushes the branch when the last step
  closes, telling the main. Steps close in order, one at a time; the checklist is also saved in `.console/checklist.md`.
- Guard: `POST /v1/guard` judges every `Bash`, `PowerShell`, `Write`, `Edit`, `NotebookEdit`, `Read`, `Grep` and `Glob` call
  with the caller's own role and worktree (git commit/push/force/tag/checkout/merge/reset, config tampering, paths outside the
  worktree and `.git`, secrets, wide deletes, download-and-run). The main has a shorter list. Fails closed for shell and
  writing tools when the console is unreachable. `guard.mode` `enforce` or `shadow` (allow and log); refusals are logged to
  `.console/state/guard.jsonl`.
- Settings dialog: a switch for `agents.bypassPermissions` (with a warning), the guard mode, and the plan's test command;
  `PUT /api/config` takes them (and still the language), `PUT /api/plan` the test command. Bypass and guard mode apply to
  sessions launched afterwards; running sessions keep what they started with.
- Launch check: 90 s after an agent is launched the console verifies it reported in and took its goal; if not, the main gets a "Launch check:" message (also for agents started from the UI) and the panel shows "Not started yet" until the agent works. Asked for by the architect.
- Start-up splash (the AndromedaCli picture, `src/ui/splash.jpg`): shown about 2 s, then faded out; it never takes clicks or keys. The page title is the commercial name, AndromedaCli (the repository and package keep the internal name multiconsole).
- Panel headers show the checklist progress (`3/7`) and two new states, `Studying` (no checklist yet) and `Blocked`.

### Fixed (found by the final review)
- Guard: commands inside if/then/fi, subshells, brace groups, PowerShell blocks and `iex "..."` are judged like any other; `timeout`, `xargs`, `watch` are looked through; a `cd` earlier in the command moves later relative paths; `rmdir/rd/del -Recurse` and piped `Remove-Item` count as recursive deletes.
- Guard: the main's `git push` / `git push origin HEAD` / `--all` are refused while the repository is on a protected branch, and pushing an existing tag by name is a tag push.
- Secrets: `.env.example` and other template files are no longer refused; `credentials.*` narrowed to real credential file types.
- Several agents started at once no longer race on the plan branch and the repository config (one lock per repository).
- The agent prompt tells it its worktree has only tracked files (install dependencies first).

### Changed
- The scheduler can start an agent asynchronously (the worktree is made first); the slot is taken at once.
- `git` retries a spawn that fails because the machine is busy (EAGAIN, EPERM, EBUSY) a few times.

## Phase 2: mod and channel (2026-10-04)

### Added
- The console mod (`mod/`, a Claude Code plugin): reports `session.start/end` and `turn.start/complete`, delivers the
  console's messages through the inbox (`$.prompt.submit`), and exposes tools by role: the main gets `spawn_agent`,
  `list_agents` and `ask_user`; agents get `list_agents`, and their native `AskUserQuestion` is intercepted.
- Channel `/v1/*` (events, inbox, ack, tools, question long-polls) with a **per-session token**; the UI token is not valid
  there and session tokens are not valid on `/api` or the WebSockets.
- Agent state derived from mod events (`starting`, `idle`, `working`, `waiting_user`, `queued`, `interrupted`), shown
  in the panel headers; the terminal text never changes it.
- Limit on active agents (default 4 global, 3 per plan): beyond it `spawn_agent` answers `queued` with the position and
  the agent starts by itself when a slot frees; lowering the limit stops nobody. One flow serves the UI button and the tool.
- Question queue (drawer, `Alt+Q`, dot on the plan tab): answers reach the waiting tool call without moving the focus.
- "Read" panel (`Alt+L` or the Read button): the last 50 answers of each session as sanitised Markdown with normal
  scrolling, filter and copy; kept on disk under `.console/state/reading/`.
- Profiles (`prompts/profiles/*.md`, plan > user > shipped), the main's instructions (`prompts/main.md`) and the agent's
  (`prompts/agent.md`) naming the deferred tools by full name.
- Tests: scheduler, registry, questions, reading, markdown sanitiser, `/v1` security, launch, profiles; browser e2e with a
  simulated mod (`test/e2e/phase2.spec.ts`) and a manual contract test with the real Claude Code and the real mod
  (`test/e2e/mod-real-claude.ts`).

### Added (after the review)
- Permission routing: an agent's permission prompt goes to the console queue (tool, command, reason; Allow/Deny) instead of
  waiting unseen in its terminal, and the answer becomes the verdict (mod hook on `tool.check`). The main keeps the native dialog.

### Fixed
- Command injection through `--model` (and any cmd.exe-bound argument) on Windows: models must be plain ids and unsafe characters are refused.
- Shutting the console down no longer starts queued agents; a `turn.complete` with a large answer (up to 2 MiB) is accepted;
  an aborted turn withdraws its question; a queued agent created from the form is no longer shown as an error.
- The mod sets up its poller and tools once per process, does not inject a message whose acknowledgement failed, and a tool-registration
  failure no longer silences its events.

### Changed
- Sessions get `--allowedTools` for the console's own tools, otherwise they stop at a permission prompt without bypass.
- `POST /api/agents` answers `202 { status: "queued", position }` when the agent has to wait.
- Oversized request bodies are drained and refused with 400 instead of resetting the connection.

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
