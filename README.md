# AndromedaCli

**One browser tab to run, watch and steer several Claude Code sessions at once.**

AndromedaCli is a local web console for [Claude Code](https://docs.claude.com/en/docs/claude-code). On the left it shows a fixed **main** session you talk to. On the right it shows the **agents** the main starts for you: each one a real `claude` terminal, working in its own git worktree on its own branch, with a ticket, a token budget and a review before anything is merged.

You stay in charge: agents never push to `main`, never touch each other's files, and anything that needs a human decision lands in one queue.

> The repository and package are called `multiconsole`; **AndromedaCli** is the product name.

## Why

One coding agent can handle a task. Several at once create a different job: who is working, who is waiting for an answer, who is stuck, what it all costs, and whose changes may be merged. AndromedaCli makes that job visible and safe:

- **See everything.** Real terminals (xterm.js) side by side, with a state dot for each agent (working, waiting for you, idle, blocked, dormant...).
- **Isolation by default.** Every agent gets `<repo>.worktrees/<name>` on the branch `agent/<plan>/<name>`; the console commits each checklist step, runs your tests and pushes only that branch.
- **One queue for you.** Questions, permission prompts, merge decisions and budget decisions all arrive in a single drawer, with desktop notifications when you are away.
- **A brake that is not the model's good intentions.** A guard checks every file and shell tool call against explicit rules before it runs.
- **Cost under control.** Per-agent token budgets, loop detection and subscription-limit handling (sleep until the window resets, wake only the main).
- **Closing the tab is safe.** The server owns every process; the browser only displays. A restart brings the main and the agents back.

## What you need

- **Windows 10 or 11.** The terminals use ConPTY, notifications are native Windows toasts and the folder picker is a native window. Other systems are not supported yet.
- **Node.js 22 or newer** and **git**.
- **Claude Code** (`claude`) installed and logged in. Open the folder you will work on once with `claude` so you have accepted its workspace-trust dialog.

Run `npm run console -- doctor` at any time to check these prerequisites and the security setup. In the app, *Options → Prerequisites* shows the same table and can install what is missing after you approve each command.

## Quick start

```bash
git clone https://github.com/FedericoMantovani89/multiconsole.git
cd multiconsole
npm ci
npm run build
npm run console -- serve
```

On Windows you can double-click `start-console.bat` instead; it installs and builds on first run. Pass a folder (`start-console.bat D:\work\my-project`) to open that project directly.

The command prints a URL with a one-time token, for example `http://127.0.0.1:7391/?token=...`, and opens it in your browser. The port is fixed on purpose (7391); use `--port` to change it.

Useful options:

| Command | What it does |
|---|---|
| `npm run console -- serve` | Opens the plans it remembers, or shows a welcome screen asking for a project |
| `npm run console -- serve --plan-root DIR` | Opens the plan in `DIR` |
| `npm run console -- serve --port N --no-open` | Another port; do not open the browser |
| `npm run console -- doctor [--json]` | Prerequisite and security self-test |

## Using it

1. **Open a project.** On the welcome screen pick a folder (Browse opens the Windows folder window). A *plan* is one project folder; the console keeps its state in `<project>/.console/`. You can open several plans as tabs. New plans can start from a **template** (`generic`, `backend-java`, `frontend-web`, or your own) that sets profiles, rules and build/test/lint commands, detected from `pom.xml`, Gradle or `package.json`.
2. **Talk to the main.** The left panel is a normal Claude Code session that knows the console's tools. Describe what you want; the main decides which jobs to start.
3. **Agents appear on the right.** The main starts one agent per job (profiles: `backend`, `dba`, `frontend`, plus the read-only `reviewer` and `recovery`), or you press *new agent* yourself. Four panels fit; more collapse into bars. Agents above the active limit wait in a queue and start by themselves.
4. **Answer the queue.** Open the drawer with the *Queue* button (`Alt+Q`). It collects questions to you, tool permissions, merge conflicts, budget decisions and the release confirmation.
5. **Review and merge.** When an agent delivers a ticket the console reruns your tests on exactly that commit, a read-only reviewer reads the diff, and the main merges approved tickets one at a time into `plan/<name>`. Reaching your real `main` takes one confirmation from you; the console then merges and pushes with a one-time token that the repository's pre-push hook checks.

Keyboard: `Alt+1` main, `Alt+2…9` agents, `Alt+Q` queue, `Alt+L` the read panel (a readable view of an agent's turns), `Alt+←/→` switch plans. Focus never moves on its own: only your clicks and these shortcuts move it. `Esc` closes the Options, new-plan and close-plan dialogs.

## How it works

```
 Browser (vanilla TypeScript, xterm.js)
        │  /ws/term/<agent>  raw terminal bytes        /ws/ui  state pushes (JSON)
        ▼
 Node process (src/server) ── owns every `claude` process through node-pty
        │   plans · scheduler · ticket flow · guard · budget · queue · notifications
        │   HTTP /api (UI token)        HTTP /v1 (one token per session)
        ▼
 claude sessions ── each loads the console mod (mod/), a thin Claude Code plugin
                    that reports events and asks the guard before each tool call
```

- **The server decides, the mod only reports.** Agent state comes from structured events sent by the mod (turn started, turn complete, tool calls), never from reading the terminal.
- **The main coordinates through tools** such as `spawn_agent`, `ticket_report`, `request_review`, `merge_ticket` and `propose_release`. The agents report with `checklist_set`, `step_done` and `report_blocked`.
- **Git belongs to the console.** The console, not the agent, commits each step, runs the plan's test command, pushes the agent's branch, and merges through its own `.plan` worktree. A per-worktree pre-push hook refuses every other ref.
- **Budget and limits.** An agent gets a token budget: alert at 80% (a WIP commit and a handover note), restriction at 100%, an orderly stop after a grace period. Repeated calls, repeated errors and compaction storms escalate from a correction to a stop. When the subscription window is nearly used, new work is halved, frozen, then stopped; the console sleeps until the window resets and wakes only the main.
- **Resume.** After a restart the main resumes its own session and the other agents are dormant (no process, no quota) until you open them, work arrives for them, or the main wakes them.

## Safety

- The server listens on **127.0.0.1 only**, with a per-start token and Host/Origin checks. Each launched session has its own token and can only call `/v1`.
- The **guard** denies force pushes, deleting remote branches, pushing tags, writing outside the agent's worktree, reading or writing files that look like secrets, tampering with the push hook or `.git`, wide `rm`, and download-and-execute. The main is bound by the git and secret rules; the main is also refused Claude Code's built-in subagents (other than read-only lookups), so file-changing work always goes through visible console agents.
- Reviewers and recovery agents are **read-only**, enforced by the guard.
- `agents.bypassPermissions` is **off by default**. When you turn it on in Options, the guard is the only brake. The guard states its limits: it does not try to stop obfuscated commands.
- Telemetry is off. Nothing leaves your machine except what Claude Code itself sends.

## Configuration

Settings live in `%APPDATA%\console\config.json` (or `CONSOLE_CONFIG_DIR`) and are edited in the **Options** dialog: models, profiles, budget and limits, names, plan, git, guard, mod, notifications, language, prerequisites, plugins and server. An invalid entry never blocks the console: the default is used and the problem is shown.

The interface is translated through `src/i18n/messages_<lang>.properties` (English and Italian today; a new language is just a new file).

## Project layout

| Path | Contents |
|---|---|
| `src/server` | HTTP/WebSocket transport, plans, agents and scheduler, tickets (review, merge, release), git, guard, budget, notifications, templates, prerequisites |
| `src/ui` | The browser UI (vanilla TypeScript, no framework) |
| `src/shared` | Wire types and rules shared by server and UI |
| `mod/` | The Claude Code plugin that every session loads |
| `prompts/` | Text sent to agents: the main's prompt and the shipped profiles |
| `templates/`, `catalog/` | Plan templates; the shipped model list and plugin catalog |
| `test/` | Unit and integration tests (real node-pty children, a fake agent instead of Claude) and the browser acceptance specs in `test/e2e` |

## Development

```bash
npm test                      # unit and integration tests (the full run takes about 12 minutes)
npx vitest run test/slug.test.ts
npm run check                 # i18n parity, no literal UI text, no stray .focus(), then tsc
npm run build                 # bundles the UI into dist/ui
npx tsx test/e2e/phase6.spec.ts   # browser acceptance in Edge (fake agents, no quota used)
```

Rules worth knowing before a change: all code, comments and docs are in English; UI code contains only translation keys; missing data is shown as "n/a", never as zero; `.focus()` may only be called in `src/ui/focus.ts`. Changes to behaviour get a line in [CHANGELOG.md](CHANGELOG.md).

## Status

The console base, the mod channel, git worktrees and tickets, review and merge, budget and limits, and multiple plans with resume, notifications and templates are built and covered by tests and browser acceptance runs with fake agents. The budget, quota-sleep and restart flows have not yet had a long run against the real Claude Code, so expect rough edges there. External providers (other coding agents) are planned as an optional next phase.

## License

[MIT](LICENSE) © 2026 Federico Mantovani
