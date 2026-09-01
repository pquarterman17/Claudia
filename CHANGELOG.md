# Changelog

Notable changes to Claudia. Versions follow [Semantic Versioning](https://semver.org/);
entries are generated from the commits since the previous tag.

## [0.1.0] — 2026-09-01

First release. Claudia is one window over every parallel Claude Code session: a local
Node server owns sessions through the Claude Agent SDK, a React board renders each one
as a live tile, and an optional Tauri shell wraps the whole thing as a desktop app.
Everything runs on `127.0.0.1`; nothing is exposed to the network.

### Session supervision

- SDK-owned sessions with live approvals — a permission prompt is a parked
  `canUseTool` promise, resolved by clicking Approve in the browser
- Permission modes including plan mode, sticky per-session permissions, an
  always-allow-in-project rule writable straight from the banner
- Plan review surface for `ExitPlanMode`, pending-edit and session-plan inspection
- Questions rendered as clickable option pickers with a real "waiting on you" state,
  one-at-a-time wizard for multi-question turns
- Live streaming replies, queued prompts shown mid-turn, context compaction surfaced
  as a feed step, full transcript with feed ⇄ chat toggle
- Sub-agents nested under the Task call that spawned them; tool results matched to
  their calls for real outcomes
- Session monitor that also shows terminal sessions Claudia did not launch

### Terminal parity

- Slash commands fetched via `supportedCommands()`, model picker with pending-switch
  indicator, per-session output style, context and reasoning controls
- `@file` mention completion in the composer, image attachments
- Session history: resume, fork, and launch-prompt continuity

### Codex as a second agent

- Protocol client for `codex app-server` (JSON-RPC), routed through the same session
  state machine, feed, and approval gate as Claude sessions
- Agent picker at launch, per-tile badge, resume and fork of past Codex threads
- Driver corrected against a live codex-cli, including its undocumented approval
  method names and Windows spawn quirks

### Fleet orchestration

- Durable SQLite store (`node:sqlite`) that survives the process, with schema
  constraints that refuse states the fleet has no meaning for
- Deterministic dispatcher — dispatch decided by arithmetic, not by a model
- Watchdog with bounded retry and backoff owned by the task, not the run
- Worktree ownership proven before writing, platform-aware path keys, refusal to
  merge two live claims
- Restart reconciliation that separates "the process stopped" from "the task is done",
  sequence-based resync with a backpressure limit, capability allow-list with
  provenance the caller cannot forge
- Cross-agent debate (two agents argue it out without you relaying) and crew (one
  objective split across several agents at once)

### Board and UI

- Tile board with session titles, per-session accent colors, branch display,
  attention-priority ordering, resizable fill-to-window layout
- Command palette (Ctrl/Cmd+K), keyboard shortcuts, status footer, desktop
  notifications, accessibility-reviewed control semantics
- Finish actions that fire once every session settles, stackable into a reorderable
  chain (notify, save learnings, commit+push on non-main branches, shut down)
- Named launch templates, saved prompts you can fire at a running session,
  usage measured against your own plan history with real limits fetched via `/cost`

### Desktop and platform

- Tauri 2 shell with native window, tray, and notifications
- Single-port production build; double-clickable launchers for Windows and macOS;
  real Linux command table; sessions stop when the last browser goes away
- Worktree launch: a session on its own branch, in its own directory

### Security

- Licensed AGPL-3.0-only
- Cross-origin WebSocket and DNS-rebinding rejection on the local server
- CodeQL enabled; flagged paths hardened; dependency audit cleared
- History audited before publishing (see SECURITY.md)

### Testing

- 1,537 tests (1,408 server, 129 web) across 90 files, type-checked test sources,
  CI matrix over Ubuntu/Windows × Node 22/24
