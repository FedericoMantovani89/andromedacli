# How it works

```
 Browser (vanilla TypeScript, xterm.js)
        │  /ws/term/<agent>  raw terminal bytes        /ws/ui  state pushes (JSON)
        ▼
 Node process (src/server) ── owns every `claude` process through node-pty
        │   projects · scheduler · ticket flow · guard · budget · queue · notifications
        │   HTTP /api (UI token)        HTTP /v1 (one token per session)
        ▼
 claude sessions ── each loads the console mod (mod/), a thin Claude Code plugin
                    that reports events and asks the guard before each tool call
```

- **The server decides, the mod only reports.** Agent state comes from structured events sent by the mod (turn started, turn complete, tool calls), never from reading the terminal.
- **The main coordinates through tools** such as `spawn_agent`, `ticket_report`, `request_review`, `merge_ticket` and `propose_release`. The agents report with `checklist_set`, `step_done` and `report_blocked`.
- **Git belongs to the console.** The console, not the agent, commits each step, runs the project's test command, pushes the agent's branch, and merges through its own `.project` worktree. A per-worktree pre-push hook refuses every other ref.
- **Budget and limits.** An agent gets a token budget: alert at 80% (a WIP commit and a handover note), restriction at 100%, an orderly stop after a grace period. Repeated calls, repeated errors and compaction storms escalate from a correction to a stop. When the subscription window is nearly used, new work is halved, frozen, then stopped; the console sleeps until the window resets and wakes only the main.
- **Resume.** After a restart the main resumes its own session and the other agents are dormant (no process, no quota) until you open them, work arrives for them, or the main wakes them.

## Project layout

| Path | Contents |
|---|---|
| `src/server` | HTTP/WebSocket transport, projects, agents and scheduler, tickets (review, merge, release), git, guard, budget, notifications, templates, prerequisites |
| `src/ui` | The browser UI (vanilla TypeScript, no framework) |
| `src/shared` | Wire types and rules shared by server and UI |
| `mod/` | The Claude Code plugin that every session loads |
| `prompts/` | Text sent to agents: the main's prompt and the shipped profiles |
| `templates/`, `catalog/` | Project templates; the shipped model list and plugin catalog |
| `test/` | Unit and integration tests (real node-pty children, a fake agent instead of Claude) and the browser acceptance specs in `test/e2e` |
