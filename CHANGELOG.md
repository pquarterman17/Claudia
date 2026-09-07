# Changelog

Notable changes to Claudia. Versions follow [Semantic Versioning](https://semver.org/);
entries are generated from the commits since the previous tag.

To cut a release: rename the `[Unreleased]` heading below to the version and
today's date, set the same version in the root `package.json`, then push the
tag. `.github/workflows/release.yml` runs the full gate on the tagged tree and
refuses to publish if those three disagree — `node scripts/release-notes.mjs
v0.2.0` says so before you tag, and prints the notes it would use.

## [0.2.0] — 2026-09-07

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
- Capability grants: one per run, issued before the child exists, and checked
  ahead of the approval banner rather than behind it. A tool the run was never
  authorised to use is refused rather than offered to a human to approve —
  which for an unattended fleet is the whole point. The policy can only
  tighten: a call it cannot classify parks on a person exactly as before
- The worktrees a mission has finished with are let go of, and then actually
  removed. Nothing is deleted automatically, nothing dirty or unmerged is
  deleted at all, and `git worktree remove` is never given `--force`

- A mission says what "green" means for its repository: one verify command, run
  in the worktree the child worked in once it reports, with the result carried
  into the judgement. Without one nothing is checked and every verdict asks a
  human, which is what every mission did before it existed
- Acceptance judged from evidence observed server-side — the branch, the base,
  the head, the diff, whether the head provably descends from its base, what
  the checks said, and what the forge says about a pull request. Never taken
  from the child's own account of itself, which is the reason `reported` and
  `accepted` are different states
- A person accepts what the evidence supports, or overrides it with a reason
  that is recorded beside the verdict it overrode. Acceptance is its own
  command rather than a status change, so it cannot skip the reading
- What each attempt spent, recorded on its run, so a mission's token budget is
  measured from numbers that outlive the sessions that produced them

### A board for the fleet

- Missions created, listed, watched and paused from the browser. A new mission
  is paused and a new task is `proposed`: two separate decisions stand between
  typing a task and paying for one
- Task rows with the moves that are a person's to make. `ready -> running` and
  `running -> reported` are deliberately absent — the first reserves a run in
  the same transaction, the second is the child's own claim
- An inbox for the decisions a mission is blocked on, with approve, deny and
  withdraw, and a note kept with the decision
- Per-mission timeline, read from the event log, paged backwards through it a
  window at a time with an honest count of what is not shown
- A mission's verify command, set and cleared from the board, refused before
  sending when it is not one command this fleet will run
- A mission's own ceilings, set and cleared from the board. Blank is no budget,
  and clearing one matters as much as setting it: a mission that has hit a
  ceiling stops dispatching, and somebody has to be able to let it carry on
- The judgement beside the task it belongs to: what changed, what nobody
  checked, and what the mission's own checks said — including when they could
  not run, which "no test results" alone does not distinguish
- A compact mission overview above the task list: what is moving, what is held,
  and one line naming the next action — drawn from the same rules the
  reconciler decides on, so the board cannot promise a dispatch the server has
  already refused
- Managed worktree cleanup, previewed before anything is removed. Every
  directory carries a reason, the kept ones included, because "why is that one
  still here?" is the question a person actually has; unmerged branches are
  confirmed one at a time

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
- **Every verdict was `needs_human`.** Nothing had ever written a test result,
  so the gate that reports missing evidence fired on every judgement and the
  branch that rejects failing checks could not be reached by any input. The
  fleet could see a diff; it could not tell whether the diff was any good
- **The evidence ran against nothing.** A launched child's run never recorded
  the worktree it was given — the launcher created it and dropped the id — so
  the acceptance judgement had no directory to read for any child the fleet had
  ever started
- **Acceptance never read the verdict.** `reported -> accepted` was a plain
  status move, so a task whose checks failed, whose diff was empty, or which
  had never been judged at all could be accepted with one click
- **Token budgets blocked rather than bound.** A mission with one was held on
  its first pulse and every pulse after, because nothing could measure what it
  had spent — and nothing in the app could set one either, so neither half of
  the limit was reachable
- **A worktree could never be adopted twice** when its repository was reached
  by any other spelling — a symlinked directory, a Windows 8.3 short path. git
  resolves a path before answering, so the second attempt at a task compared
  two spellings of one directory and refused, and the two spellings would have
  built two worktree trees over one checkout
- **The timeline showed its oldest page as its newest**, and then reported the
  number of hidden events going backwards as more of them arrived
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
- **Retired worktrees were never removed.** The retire pass ran on every pulse
  and marked records idle; nothing ever touched the directories they named, so
  a long-running fleet reclaimed no disk at all
- **An escalation could not expire.** `expiresAt` was stored and `expired` was
  legal in the schema, and no code path ever wrote it, so a request with a
  deadline behaved exactly like one without: pending for good
- **Capability grants were never checked.** The rules existed and there was no
  table to keep a grant in, nothing that issued one, and no lookup — so the
  module's own claim, that a grant is only ever reached by looking it up for a
  run, described something that did not exist
- The attempt under review was recorded when a task entered `reported` and
  never cleared when it left, so a requeued task pointed at the attempt that
  had just been sent back

### Infrastructure

- Tag-triggered release workflow that runs the full gate on the tagged tree and
  refuses to publish when the tag, `package.json` and the changelog disagree
- A pulse that decides nothing now says why, once per fault rather than every
  fifteen seconds, and a mission held by its own budget says so in its log
- Test guardrails that read the source rather than a hand-maintained count: one
  over the `ServerEvent` union, one over `ClientCommand`, one over the fields
  of the evidence — which named four that nothing wrote, and refused to pass
  again until they were collected. Each was added after the version it replaced
  failed to catch a real omission
- Tests are held to running on every platform: a suite may only start programs
  every runner has, and one that runs processes has to know which platform it
  is on. Three Windows failures in one week were fixtures rather than code
- `noUnusedLocals` and `noUnusedParameters` on, after five dead imports reached
  the default branch and were found by a scanner rather than by the build

### Testing

- 2,327 tests (2,061 server, 266 web) across 126 files, on the same
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
