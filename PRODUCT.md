# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Developers who run several Claude Code sessions at once on their own machine and want to see and steer them in one place. Long sessions, many hours in front of the console. Intended to be published as a product for external users.

## Product Purpose
AndromedaCli is a local web console that runs and shows several Claude Code sessions: a fixed "main" on the left, manually launched agents on the right. It also handles the user's question queue, review and merge of agent work, budget and quota, multiple plans, notifications, templates and settings. Success: the user always knows which agent is doing what, what needs their answer, and what it costs.

## Positioning
One Node process owns every `claude` process; the browser only displays, so closing the tab never touches a session. Agent state comes from structured events, not from reading the terminal.

## Operating Context
Runs on 127.0.0.1 with a per-start token. Real terminals (xterm.js) are the core content. Main is always the left half; up to 4 agent panels, then collapsed bars. Keyboard focus never moves on its own (only `src/ui/focus.ts` calls `.focus()`).

## Capabilities and Constraints
- Vanilla TypeScript UI, no framework; styles in `src/ui/styles.css`.
- No user-visible text in UI code: only i18n keys (`src/i18n/messages_<lang>.properties`, en and it). Texts of different length must fit.
- Missing data is shown as "n/a", never zero; unknown is never "ok".
- Re-parenting DOM nodes drops keyboard focus: keep nodes stable.
- `npm run check` (literal-string, focus and i18n lints) is the build gate.

## Brand Commitments
Commercial name AndromedaCli (repo stays `multiconsole`). The user gave total freedom on the visual identity, including the splash image and layout arrangement, as long as the SPEC behaviours above hold.

## Evidence on Hand
Existing UI in `src/ui`, splash image `src/ui/splash.jpg`. No testimonials, customers or benchmarks exist; none must be invented.

## Product Principles
- State is legible at a glance: who works, who waits for the user, who is stuck.
- The terminal is the content; the interface recedes around it.
- Honest data: unknown is shown as unknown.
- Built for long sessions: calm, low fatigue, no decoration that competes with the terminals.

## Accessibility & Inclusion
Keyboard-first use; visible focus; respect prefers-reduced-motion; two UI languages (en, it).
