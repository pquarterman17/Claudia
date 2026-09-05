# Changelog

Notable changes to Claudia. Versions follow [Semantic Versioning](https://semver.org/);
entries are generated from the commits since the previous tag.

To cut a release: rename the `[Unreleased]` heading below to the version and
today's date, set the same version in the root `package.json`, then push the
tag. `.github/workflows/release.yml` runs the full gate on the tagged tree and
refuses to publish if those three disagree — `node scripts/release-notes.mjs
v0.2.0` says so before you tag, and prints the notes it would use.

## [Unreleased]

The fleet stops being a plan, and then stops being unreachable. Claudia can now
hold a standing intention — a mission with tasks — and act on it without a
human in the loop: it reconciles what should happen next, reserves the attempt
durably, starts a real Claude Code child in its own git worktree on its own
branch, watches it, retries or escalates when it stalls, and records the claim
when it finishes. All of it survives a restart, because all of it is rows
rather than memory, and all of it is now driveable from the board.

Second theme: the board can read the conversations of sessions Claudia did not
launch. It could already see that a terminal session was working; it can now
show what it is saying.

### Fleet orchestration

- Durable fleet store opened at boot — missions, tasks, child runs, worktrees,
  escalations and an append-only event log in a STRICT SQLite file with
  versioned migrations, opened once and reported as a value when it cannot be
- Crash recovery: runs left `dispatched` or `running` by a killed server are
  reconciled against the sessions that no longer exist, at boot, before
  anything decides to spend
- Mission and task commands on the wire, plus a resumable fleet event stream
- The pulse: a clock that turns the reconciler's decisions into durable writes,
  at each mission's own cadence. The run row IS the reservation, so a repeated
  pulse cannot pay twice for one attempt, and a launch that fails after the
  commit releases its slot rather than holding it for the life of the mission
- Watchdog over silent runs, runs parked on a human approval, and orphaned
  runs, with bounded retries and backoff — and a starting grace, so a child is
  not killed in the seconds between its reservation and its session existing
- A launcher that starts real children: a claimed worktree, a branch of its
  own, a brief built from the task, and the session id written back onto the
  run that reserved it
- A child can finish. A session idle since after its run started is the child
  saying the work is done, which lands the run and its task on `reported` — a
  claim awaiting a decision, never an acceptance
- A mission chooses which harness its children run on, Claude or Codex
- Fleet-wide child and attempt ceilings as a stored preference, read at every
  pulse rather than pinned in source, and settable from the board

### A board for the fleet

- Missions created, listed, watched and paused from the browser. A new mission
  is paused and a new task is `proposed`: two separate decisions stand between
  typing a task and paying for one
- Task rows with the moves that are a person's to make. `ready -> running` and
  `running -> reported` are deliberately absent — the first reserves a run in
  the same transaction, the second is the child's own claim
- An inbox for the decisions a mission is blocked on, with approve, deny and
  withdraw, and a note kept with the decision
- Per-mission timeline, read from the event log

### Mirroring sessions Claudia did not launch

- One session's conversation read out of its transcript on disk, resumable by
  byte offset and safe against the partial trailing line a live session always
  has
- A mirror service that follows a foreign session on the wire, with a backlog
  on open and chunked tailing after it, costing nothing when nobody is watching
- A read-only tile for an observed session: expandable, clearly marked, with no
  composer and no way to approve, interrupt or prompt — because none of those
  are things Claudia can do to a session it does not own

### Fixed

- **The board stopped updating.** Seven cases — `session_upsert`,
  `session_removed`, `settings`, `usage`, `trigger_status`, `notice` and
  `folders_picked` — were deleted from the client's event switch while a
  reducer was split out of it. New sessions never appeared, stopped ones never
  left, usage never moved and the folder picker did nothing until a reload.
  Restored, with a test that reads the protocol and fails if any event is
  unhandled
- **Mission budgets enforced nothing.** `budgetSec` was persisted, settable and
  compared against nothing: the pulse never measured what a mission had spent,
  so every mission was under budget forever
- **A finished child was retried.** With no path to `reported`, a child that
  did its work went idle, read as silent, and was retried at full price until
  its attempts ran out and the task was failed
- **Escalations went nowhere.** The watchdog filed them into a table with no
  wire surface and no note in the timeline, so a mission parked on a human
  simply stopped moving and said nothing about why
- `usage-reader` advanced its offset to the file size before reading, so a
  record split across two scans was lost permanently rather than re-read. Rare
  and small for token accounting; a dropped message for a mirror, and most
  likely on exactly the sessions being watched live
- Fleet children were stopped by the idle-browser reaper: closing the last tab
  killed work nobody was watching by design
- `set_task_status` was handled but never routed, so the mission layer was
  unreachable from the wire
- A run's session could be attached to a reservation that had already been
  retired

### Infrastructure

- Tag-triggered release workflow that runs the full gate on the tagged tree and
  refuses to publish when the tag, `package.json` and the changelog disagree
- A pulse that decides nothing now says why, once per fault rather than every
  fifteen seconds, and a mission held by its own budget says so in its log
- Test guardrails that read the source rather than a hand-maintained count: one
  over the `ServerEvent` union, one over `ClientCommand`. Both were added after
  the counted version failed to catch a real omission

### Testing

- 1,775 tests (1,603 server, 172 web) across 108 files, on the same
  Ubuntu/Windows × Node 22/24 matrix

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
