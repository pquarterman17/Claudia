# Claudia — Main Plan

One window over every Claude Code session running in parallel. Sessions are owned by a local
Node server via the Claude Agent SDK (`query()`), rendered in a React web UI at localhost.
Supersedes the Tauri+PTY plan drafted during design: its product surface carries over, its PTY
architecture does not. The Claude Design export that started this is deliberately untracked
(see `.gitignore`) — throwaway scaffolding, not project source.

**Status:** Active
**Created:** 2026-07-25
**Updated:** 2026-08-29

All of Tier 1 and Tier 2 as originally scoped has shipped; what remains below is either
genuinely new work or was deliberately deferred for a decision. 624 tests, clean typecheck.
Everything so far was built and verified on Windows only — see #13.

---

## Context

### How the pieces fit together

```
browser (React, Nocturne DS) ── WebSocket ── server (Node/TS)
                                              ├─ SessionManager: one Agent SDK query() per session
                                              │    streaming input (AsyncIterable) → follow-up prompts
                                              │    canUseTool callback → pending approval → WS → UI
                                              │    message stream → feed events + cost/usage
                                              ├─ UsageReader: ~/.claude/projects/**/*.jsonl watcher
                                              └─ TriggerEngine: armed action fires when all settled
```

- `server/` — Fastify + ws. Session registry with explicit state machine:
  `starting → working → awaiting_approval → working → idle`, `error` from any, `stopped` terminal.
  States come from SDK events (structured), never from parsing terminal text.
- `web/` — Vite + React. Session tiles with feed view, approval banners, controller tile with
  the finish chain, usage panel. The Nocturne design tokens were copied into
  `web/src/nocturne.css`, which is tracked; nothing reads from the design export.
- `shared/` — TypeScript types for the WS protocol (events server→client, commands client→server).

### Key platform facts (researched 2026-07-25)

- Agent SDK `query()` gives: streaming messages, `canUseTool(toolName, input) → allow/deny`
  (this IS the approval prompt — no heuristics), `interrupt()`, `resume`/`forkSession`,
  `result` messages with `total_cost_usd` + per-model usage.
- Headless CLI cannot broker permissions over stdin — SDK is the only full-control path.
- No API exposes plan-window limits; limits are user-configured (as in the design).
- No attach path to already-running interactive terminals; hooks (`Notification`, `Stop`,
  `PreToolUse`) POSTing to the server are the only telemetry from outside sessions (Tier 2 item).

### Scope correction — single machine, two operating systems (2026-07-25)

Claudia supervises sessions on **one machine at a time**. The owner works from a Windows
desktop and a MacBook at different times, so the app must run natively on both — it does
**not** federate sessions across them. Consequences:

- No remote agent, no mTLS pairing, no host scoping. The prototype's "Both hosts /
  macbook-pro / win-desktop" selector and per-tile host chips are **cut**.
- What replaces it: cross-platform correctness (item 10) — path display, shell selection,
  notifications, and the finish-action command table per OS.
- Multi-host federation is explicitly out of scope. Do not reintroduce it without a new ask.

### Dependency map

- Items 4, 5, 6 are independent of each other.
- Item 7 (trigger engine) needs 4. Item 8 (hooks monitor) is independent of everything.
- Item 10 (cross-platform) is continuous, not a milestone — verify on both OSes as you go.

### Resolved decisions

- **2026-08-29 — #7 commit+push:** commits and pushes, but **refuses outright on `main`/`master`**.
  Encodes the owner's standing branch-before-implement rule: work happens on `feat/`/`fix/`
  branches and main is reached only by a deliberate merge. Scope the commit to files the session
  touched, so an unrelated dirty tree is not swept in.
- **2026-08-29 — #16 release:** tag + CHANGELOG generated from commits since the last tag + a
  `gh release`. No package publishing.
- **2026-08-29 — #8 hooks monitor:** approved to edit the owner's global
  `~/.claude/settings.json` directly, with the existing file copied aside first and the exact
  change reported back.
- **2026-08-29 — #11 Tauri wrap:** wanted. Native window, tray and notifications around the web UI.

## Tier 1 — High Impact

### Terminal-parity initiative (2026-07-26)

Goal: full functional parity with the interactive Claude Code terminal, keeping Claudia's
multi-session legibility — the owner likes the terminal and only loses track of which window
is which. Decisions: reading = feed ⇄ transcript toggle per tile; identity = auto-titles +
manual rename + color accents, first; review surfaces (edit diffs, plan mode) deliberately a
later tier since the owner mostly runs with permissions skipped.

### Parity gap audit (2026-07-26)

Full inventory of the interactive terminal against the SDK surface, cross-checked by probing a
live session rather than trusting docs alone. Two probe results overturned assumptions this
plan was built on, so they lead the list. Items marked **probe first** have an unverified SDK
path — measure before building.


## Tier 2 — Medium Impact

45. **Codex (ChatGPT) sessions as a second agent** — one board, two kinds of tile. The protocol
    layer has shipped; integration and UI are in flight.
    - [x] `codex app-server` JSON-RPC client, router onto the existing `RoutedMessage`, process
      host, 35 tests, missing-binary path verified
    - [x] Driver seam in `session.ts` so both agents share the state machine, feed and gate
    - [x] Agent picker at launch + per-tile badge, with Claude-only controls disabled and the
      reason attached
    - [x] **Verified against a live codex-cli 0.151.0** (2026-07-26): full loop, including an
      approval parked in Claudia's gate and released from the client —
      `starting -> working -> awaiting_approval -> working -> idle`, thread id and token
      counts reported. Four defects only the real binary exposed: Node cannot spawn either of
      the Windows PATH entries (`.cmd` shim + POSIX script, no `.exe`); `thread/started`
      carries `{ thread: { id } }` not a top-level `threadId`; token usage is nested under
      `tokenUsage.total` in camelCase; and this CLI sends
      `item/commandExecution/requestApproval` rather than the documented
      `execCommandApproval`, with `accept`/`decline` instead of `approved`/`denied`.
    - [x] **Resume and fork** (2026-07-26) — `thread/list` feeds the picker (both agents merged,
      newest first, tagged by agent), `thread/resume` restores history and `thread/fork` copies
      it. Verified live: a resumed thread recalled 5192, a fork recalled 7734 while the original
      stayed open. Codex threads are SINGLE-WRITER, so resuming one still open in another tile
      is refused — the error now says so and points at fork. Listing is bounded by a timeout;
      without one a wedged app-server left the picker spinning forever.
    - Known asymmetries, by measurement not guesswork: Codex reports token counts but **no
      dollar cost**; usage arrives on its own `thread/tokenUsage/updated` notification; its
      sub-agents are separate threads rather than nested calls; `/cost`, `/context`, the MCP
      panel, settings inspector and file rewind are Claude-only. Model choice is NOT a gap —
      an earlier assumption that it was had disabled the picker for no reason.


7. **"Commit + push" finish action** — deliberately disabled in the UI rather than shipped
   as a silent no-op. Needs per-repo rules before it pushes unreviewed work: which repos are
   eligible, what to do with a dirty tree, whether to open a PR instead of pushing. Now more
   wanted than before, since it is the natural first link of a chain.
16. **"Make a release" finish action** — mentioned as a chain example. Not built: a release
    means different things per repo (tag? changelog? `gh release`? npm publish?). The wrap-up
    script action covers it today; a first-class version needs the owner's actual process.
8. **Hooks monitor tier** — global hook POSTs to server so plain-terminal sessions appear as
   read-only tiles. The only way to see sessions Claudia did not launch. Requires editing the
   owner's global `~/.claude/settings.json`, so ask before touching it.

## Tier 3 — Nice-to-Have

42. ~~**`@file` mention expansion**~~ — **probed 2026-07-26: it DOES expand.** A prompt of
    "@SECURITY.md — reply with only the first heading" answered correctly with ZERO tool calls,
    so the file was included before the model saw it. That settles #28: an autocomplete is
    worth building, and saves a Read round-trip every time it is used.


### Terminal features with no SDK path (documented, not planned)

Recording these so they are not rediscovered as bugs:

- **Conversation-level rewind.** `rewindFiles()` restores code only. `/rewind`'s "restore
  conversation", "restore both", and the two point-scoped summarize options have no equivalent.
- **`/branch` semantics.** A fork is a new process; in-process branch behaviour (carried
  permission grants, background tasks continuing) is not reproducible.
- **Force-backgrounding an in-flight tool call** (terminal `Ctrl+B`).
- **`/status`, `/help`, `/todos` as commands** — measured in a live SDK session: `/todos` is
  "Unknown command", the other two reply "isn't available in this environment". Todos are still
  reachable as `TaskCreate`/`TaskUpdate` tool calls in the stream (#27).
- **Product commands** (`/login`, `/upgrade`, `/ide`, `/install-github-app`…) — out of scope by
  construction; Claudia is not the Claude Code product.

## Completed

- ~~**#11 Tauri wrap**~~ (2026-08-30) — a native shell over the same web UI: own window, tray,
  and real OS notifications (registering the notification plugin injects a `window.Notification`
  shim, so the existing `notifications.ts` was not touched). Two behaviours matter more than the
  window itself, because sessions live INSIDE the server process: it ATTACHES to an
  already-running Claudia rather than spawning a second one (a second server is a second,
  disjoint board), and it only ever stops a child it spawned — `ServerProc` holds `None` for both
  "nothing spawned" and "attached", so the two cases that must behave identically on Quit are one
  state rather than a rule to remember. Window close hides to tray; only tray Quit stops a server.
  Verified live against a running instance, including that killing the child leaves no orphaned
  grandchild. Review then found the splash's error banner hand-escaped its message without
  handling a carriage return — a Windows failure message is CRLF-terminated, so the generated JS
  did not parse and the banner stayed blank at exactly the moment it exists for. serde_json now
  builds the literal.
- ~~**Rust arrived without a size guard**~~ (2026-08-30) — the ratchet only scanned TS/TSX, so a
  new language entered the repo unguarded and its first file was 579 lines against a 400 ceiling.
  The ratchet now scans `src-tauri/src/**/*.rs`, and `main.rs` was SPLIT by responsibility (81
  lines of wiring + server/health/window modules) rather than pinned, per the rule that pins are
  for legacy files only. The guard was proven to fail on an over-ceiling file before being
  trusted. NOTE the sibling `quantized` has the same shape — a 501-line `src-tauri/src/main.rs`
  with no Rust ratchet — and is a candidate for the same treatment.

- ~~**#12 Per-project auto-allow rule, respecified**~~ (2026-08-29) — an approval banner offers
  a third action, "Always allow `<exact rule>` in this project", that writes into the project's
  `.claude/settings.local.json` (not `.claude/settings.json` — that one is shared and often
  committed; a personal convenience rule has no business in a commit, and the `.local` file
  already wins on precedence) and approves the pending call. No parallel rule system: this is
  the one place Claude Code itself looks. The derived rule is always an EXACT match, never a
  `:*` prefix — a prefix would authorize more than the single call just approved (`Bash(npm run
  build:*)` would also cover `npm run build && rm -rf /`), so `permission-rules.ts` only ever
  emits the literal command or path, wrapped in `ToolName(...)`, and returns undefined (no
  button offered) for anything it cannot narrow this way — bare wildcards, empty/whitespace,
  oversized input, multi-line commands, `..` path traversal, and any tool name it does not
  specifically recognise, which is what keeps a Codex tool call ('Codex Command'/'Codex Patch')
  from ever getting a button that would write a rule Codex never reads. `settings-writer.ts`
  merges the rule into `permissions.allow` via temp-file + fsync + rename, preserving every
  other key and rule, exact-match deduping, and aborting untouched on unparseable existing JSON.
  Verified: the UI shows the literal rule string before it is written, never a paraphrase. Only
  Bash/PowerShell (command) and Edit/Write/Read/NotebookEdit (file_path) are covered — Glob/Grep
  were left out because they can carry both `pattern` and `path` at once with no given fact
  settling which one the rule should key on. The Bash form was then VERIFIED end to end against a
  live session on 2026-08-29: `rmdir nonexistent` prompts, the feature's own `deriveAllowRule` +
  `addAllowRule` write `Bash(rmdir nonexistent)`, and the identical call then runs unprompted —
  so an exact rule with no `:*` really does match. Two false readings had to be cleared first:
  Claude Code auto-approves read-only commands (`whoami`) by its own heuristic regardless of any
  rule, and an empty permission log means nothing unless the tool call is separately confirmed to
  have happened. The file-path form (Edit/Write/Read/NotebookEdit) remains UNVERIFIED and cannot
  be tested on this machine, because the owner's global settings bare-allow those tool names, so
  they never prompt here for any project. `session.ts` and `gateway.ts` were both at the 400-line ratchet ceiling with no room to
  add a wired-up call; `gateway.ts`'s `broadcastSettings` was extracted to `settings-event.ts`
  to buy room (a real module boundary, not just a line-count trade), and `session.ts` landed
  exactly at 400 by adding one delegating line with no blank-line separator, matching that
  file's existing one-liner cluster.
- ~~**#43 Compaction visibility**~~ (2026-08-29) — a compaction now lands in the feed naming
  whether it was automatic or a `/compact` you ran, and the context size before it. Review
  caught the count being formatted with a bare `toLocaleString()`, which follows the HOST
  locale: the same session read "152,341" here and "152.341" under a European locale, and the
  test asserting it would have flipped depending on where CI ran. Pinned at the source.
- ~~**#28 `@file` autocomplete**~~ (2026-08-29) — bounded server-side file search
  (`file-search.ts`: 200 ms budget, depth 10, never descends `node_modules`/`.git`/dist, never
  rejects) plus completion in the composer. Measured on this repo: 6 ms and no `node_modules`
  leakage. Stale replies are keyed to the query that produced them, so a slow answer for `@ses`
  cannot repopulate a dropdown that has moved on to `@sess`.
- ~~**#41 Output style per session**~~ (2026-08-29) — per-tile picker fed by one
  `initializationResult()` call, cached per session. Degrades to "not supported" on Codex for
  free, since the capability is read from `agent-kinds` rather than tested inline.
- ~~**Parallel-lane collision**~~ (2026-08-29) — #28 and #41 were built concurrently and both
  extracted the same `runBulk` out of `gateway.ts` to make ratchet room, under two different
  filenames. Merged to one. Worth remembering: concurrent lanes each measure headroom against a
  base the other is about to change, so re-measure after merging, never before.

- ~~**#27 Session todo list**~~ (2026-07-26) — shipped with the external stack as
  `todo-tracker.ts` + `TodoPanel.tsx`; found already done during a reconciliation pass, never
  struck at the time.
- ~~**#28 image paste**~~ (2026-07-26) — the composer takes pasted, dropped and chosen images,
  bounded at four per prompt and 5 MB each. The `@file` half remains as #28.
- ~~**#29 edit-approval diffs**~~ (2026-07-26) — approvals render a before/after preview. The
  plan-mode half shipped separately on 2026-08-29; see below.
- ~~**#29 plan-mode review surface**~~ (2026-08-29) — `ExitPlanMode` already reached `canUseTool`
  (probed live: input is exactly `{ plan, planFilePath }`, no `file_path`), so the plan branch in
  `approval-change.ts` had to be checked before the file_path bail-out or it would never fire.
  Gets its own preview bound (20,000 chars vs. the 1,000-char diff preview) since a plan is prose
  meant to be read, not a diff — the first plan probed ran 1,140 chars, already past the old
  limit. New `PlanReview.tsx` tile renders it via the existing markdown-lite renderer and offers
  Approve or a free-text "ask for changes", which needed no new protocol: it rides the `deny`
  command's existing optional `message`.

- ~~**Ideas taken from a rival orchestrator**~~ (2026-07-26) — the owner liked its controls, not
  its look. Three gaps were real; the rest of its monitoring layer Claudia already had.
  **Toolkit**: saved prompts fired at a session already RUNNING (templates only ever launch
  one) — in the sidebar and the command palette, searchable by prompt text, targeting the
  focused session or the only one, scopable to a directory. Deliberately not the grid of emoji
  buttons it came from. **Branch on every tile**: the sharpest finding — tiles were labelled by
  directory, but the workflow is a branch per feature IN ONE REPO, so parallel sessions looked
  identical. Cached per directory, on a 15s clock. **Worktree launch**: a session on its own
  branch beside the repo, reusing rather than failing, and never deleting — a worktree can hold
  uncommitted work. Explicitly rejected: file tree and diff pane (not an IDE), mascots and
  emoji, cross-machine agent rendezvous (multi-host was cut deliberately).

- ~~**Licence: AGPL-3.0**~~ (2026-07-26) — Apache-2.0 was the first instinct, chosen to stop a
  company monetizing a fork; it would not, being permissive. Plain GPL would not either, since
  its obligations trigger on distribution and the realistic exploit is running a modified copy
  as a service. AGPL section 13 counts network use, which is the actual match. The limit is
  worth remembering: no OSI licence can forbid commercial use at all (OSD 6) — AGPL stops
  changes being kept, not selling. Section 13 also binds whoever deploys it, so the footer
  carries a source link. Also caught on the way: `nocturne.css` was carrying its design
  export's internal review commentary and a reviewer's name verbatim; reworded.

- ~~**#25 resume+rewind, #26 context awareness, #31 /context, #33 effort+thinking, #35 resume, #36 checkpoints, #37 fork, #38 MCP panel,
  #39 settings inspector, #40 background tasks, #44 session.ts extraction**~~ (2026-07-26) —
  landed as an external seven-PR stack (#18–24) built directly on this plan, reviewed
  adversarially and merged with fixes. Verified live: /context parses real CLI output, fork
  carries the conversation. Review found and fixed a server-killing bug (unhandled rejections
  in every new websocket handler — one failing MCP server killed the supervisor on page load,
  reproduced then re-tested), a transcript that overstated image attachments, inspector buttons
  that spawned sessions and spent a turn, and checkpoint labels that were 96% "User message".
  Also #13 macOS: a real osascript start-directory fix plus docs/macos-qa-checklist.md — still
  no hands-on Mac validation.

- ~~**#30 Real plan limits from `/cost`**~~ (2026-07-26) — pure `cost-parser.ts` + user-triggered
  refresh; verified live capturing 26% session / 28% weekly / 26% weekly-Fable with reset times.
  History estimate kept as the fallback. Capture waits for a reply that parses, so asking a busy
  session no longer fails silently.
- ~~**#32 Plan mode**~~ (2026-07-26) — `plan` added to the mode union, launch bar and a new
  per-session mode menu; `permission-switch.ts` needed no change (it is mode-agnostic) and new
  lifecycle vectors V21–V23 prove it rather than assuming it.
- ~~**#34 Command discovery**~~ (2026-07-26) — `supportedCommands()` returns
  `{name, description, argumentHint, aliases}`. Key finding: `/cost` is NOT a top-level command,
  it is an alias of `/usage`, so aliases are flattened into selectable entries. Composer now
  shows descriptions and argument hints. The hard-coded merge stays as the fallback path.

- ~~**Terminal parity Tier 1 (#22-24 + most of #18/#23)**~~ (2026-07-26) — three sonnet lanes
  (identity / controls / transcript) around a pre-carved protocol + session core; all three
  completed this time (the watchdog stayed silent). Shipped: auto-titles via the SDK's
  generateSessionTitle with click-to-rename and FNV-1a accent colors (same-repo twins now
  visually distinct); model picker from supportedModels(), slash-command autocomplete over the
  init-provided list (65 here — slash commands DO execute via stream input, probe-verified),
  up-arrow prompt history, "new conversation here"; full transcript per session with feed⇄chat
  toggle, hand-rolled markdown-lite, collapsed thinking and tool I/O. E2E caught one gap —
  the launch prompt missing from the transcript — fixed and pinned as vectors V19/V20.
  Deferred from #23: effort control (setMaxThinkingTokens mapping unclear; revisit).

- ~~**Session lifecycle vector suite**~~ (2026-07-26) — 18 deterministic vectors driving
  ClaudiaSession through a fake SDK query injected at the query-factory seam: launch shapes,
  every permission-toggle path including the exact shipped race (superseded loop terminating
  late), input-queue carryover, termination, streaming, turn queue. Two vectors failed on
  first run: one exposed a real live bug (a relaunch left the half-streamed draft as ghost
  text — fixed), one exposed wrong fake semantics (corrected against the live repro's observed
  behaviour). This suite exists because the toggle bug shipped with every unit test green —
  the failure lived in orchestration nothing exercised.

- ~~**GitHub + Linux support**~~ (2026-07-26) — private repo at pquarterman17/Claudia with CI
  (Ubuntu + Windows: typecheck, both suites, production build), monthly grouped Dependabot,
  vulnerability alerts. First-ever Linux run of the suite passed. Linux finish actions were
  broken-by-fallback (ran Windows commands) — fixed with real commands and a test pinning that
  no Linux action resolves to a .exe. README rewritten for cold pickup on all three platforms
  with an explicit only-Windows-human-verified honesty note.

- ~~**Delegated wave (items #9, #14, #17 + templates + queue visibility)**~~ (2026-07-25) —
  four features built by sonnet subagents from file-level specs in manual worktrees, reviewed
  and integrated by the coordinating model. Session templates; queued-prompt visibility
  ("N queued" chip; the CLI already queued them invisibly); chain ▲▼ reorder (edit still
  disarms); custom usage ceilings for the `custom` tier; Ctrl/⌘K command palette.
  All verified live over the wire. Lessons: two of four agents died mid-run in the same
  minute (provider stall) — the salvage was cheap because specs were file-level and worktrees
  kept partial work isolated; union-merges of append-conflicts need a duplicate-JSX check;
  one agent correctly triggered the ratchet-extraction fallback clause.

- ~~**#1 Walking skeleton**~~ (2026-07-25) — npm workspaces (shared/server/web), WS gateway,
  SessionManager over Agent SDK `query()`, ApprovalGate resolving `canUseTool`, React UI on
  Nocturne tokens. Verified in-browser: two concurrent sessions, live feed, follow-up prompts
  with session continuity, cost/token aggregation. Approval round-trip verified via
  `scripts/smoke.mjs` (`starting → working → awaiting_approval → working → idle`).
  36 unit tests; 400-line size ratchet in place.

### Resolved decisions (2026-07-25)

- **SDK-owned sessions, not PTY.** State comes from structured SDK events; the design plan's
  PTY + heuristic-parsing risk is designed out rather than mitigated.
- **Local web app, not Tauri.** Faster iteration and the second host gets a view for free by
  pointing a browser at it. Tauri stays available as a later wrapper (item 11).
- **Repo is `Claudia/`**. The Claude Design export is untracked and will be deleted; the only
  thing that survived it is `web/src/nocturne.css`.

### Plan limits: partly WRONG, corrected 2026-07-26

> **Superseded.** Probing a live session showed `/cost` sent as a prompt returns real
> allowance — session %, weekly %, per-model %, with reset times. The conclusion below held
> only for *documented HTTP APIs*; it missed that the CLI surfaces its own accounting through a
> slash command the SDK can send. Item #30 acts on this. The rest of this section stands,
> including the weighting facts and why invented tier ceilings were removed.

There is no public *HTTP API* for remaining plan allowance, so the bars were estimates
against a user-set tier. Verified rather than assumed:

- `/usage` exists, but its own docs say the breakdown is computed from *local session history
  on this machine* — it is not authoritative server state, and other machines are invisible to it.
- No CLI flag, no SDK method, no documented endpoint. OpenTelemetry exports
  `claude_code.cost.usage` / `token.usage` but explicitly carries no rate-limit data.
- Checked this machine directly: the JSONL `usage` object has
  `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`,
  `service_tier` — and **no** quota, limit, or reset field.
- The Reddit-known monitors (`ccusage`, `claude-monitor`) parse the same local JSONL and divide
  by hardcoded tier multipliers. They estimate because nothing better exists.
- Anthropic publishes tiers only as multipliers (5x, 20x) and rough prompt counts, never as
  token or dollar ceilings.

Consequence: ship a tier picker plus editable ceilings, and **say in the UI that it is an
estimate from local history**. Do not present a percentage as though it came from the server.
`claude-monitor`'s trick — reading a `rate_limits` statusline field when fresh and falling back
to estimates — is the only "closer to true" option; worth a look if the bars feel too vague.

### Gotchas found the hard way

- **Pin the SDK to `^0.3.x`.** `^0.1.0` resolves to 0.1.77, where *every* tool call dies with
  `tool_use ids must be unique`. Cost an hour; the fix is the version, not the code.
- Sessions inherit `~/.claude/settings.json` (81 allow rules here), so most Bash commands
  auto-approve. To exercise the approval path, use something outside the allowlist (`docker`).
- **Never take usage from `assistant` messages.** Their `usage.output_tokens` is a placeholder
  — measured 1 against a real 306 — and summing `cache_read_input_tokens` across a turn
  re-counts the same cache every call. Only `result.modelUsage` is correct. It is **cumulative**
  per session, so assign it, never add. (`result.usage` is per-turn; `modelUsage` is not.)
- `tsx watch` cannot rebind a held port. A stale server survived a `pkill` on Windows and
  silently served old code to a smoke test — the new process had already died on `EADDRINUSE`.
  Check `netstat -ano | grep :4317` before trusting a behavioural test.

- ~~**#4 Controller tile**~~ (2026-07-25) — finish-action selector, arm/disarm with live
  countdown, hold reason, bulk approve/interrupt. Aggregate counts stayed in the top bar
  rather than being duplicated here.
- ~~**#7 Trigger engine**~~ (2026-07-25) — `trigger-engine.ts` + per-OS `finish-actions.ts`,
  server-ticked once a second. 18 unit tests on the state machine. Verified live in-browser:
  armed with no sessions → held ("no sessions to wait for"); launched a session → held
  ("1 session still working"); settled → counted 30→0 → **fired a real Windows toast** and
  disarmed itself. A prompt sent mid-countdown cancelled it back to `armed` and the countdown
  later restarted from full, not from where it stopped. Shutdown selected → armed refused
  without a second confirming click, with `shutdown.exe /s /t 0` shown in red.

- ~~**#5 Usage panel**~~ (2026-07-25) — reads Claude Code's own JSONL logs, so it covers
  terminal sessions too, not just Claudia-owned ones. Incremental byte-offset reads keep it
  cheap: 515 ms for the first pass over 81 MB, 21 ms per rescan thereafter.

  **The default measures against your own history, not an invented ceiling.** A first version
  used community-estimated tier ceilings; measured against real logs those were out by more
  than an order of magnitude (a genuine week came to ~332M weighted tokens against an invented
  14M "Max 20x" ceiling), which pegs every bar at 0% and teaches the user to ignore the panel.
  Comparing against a median day of your own is self-calibrating and needs no invented numbers.
  Once past the reference the UI reports the multiple ("14.4× of typical") rather than "0% left",
  which distinguishes just-over from ten-times-over. Tier buttons remain as an override, labelled
  as estimates.

  Corrections to earlier notes in this file: `stats-cache.json`'s `costUSD` is **0** and it lags
  a day or two, so it is not usable for spend — it was not used. And JSONL `output_tokens` are
  **real** (median 418 on a live session, no placeholders); only the SDK's streaming assistant
  messages carry the placeholder.

- ~~**#3 Feed fidelity**~~ (2026-07-25) — tool steps start `running` and are patched with a
  duration and OK/ERR when their result lands. Matching is by `tool_use_id`, not order: results
  genuinely arrive out of order (verified with two parallel Bash calls where the second returned
  first, an approval interleaved between them). Steps still open when a session dies are marked
  abandoned so nothing spins forever.
- ~~**#4 Controller follow-ups**~~ (2026-07-25) — per-session interrupt, a skip-perms toggle on
  every tile that switches a *live* session's permission mode, and a controller banner counting
  unprompted sessions with one-click "require approvals".
- ~~**#6 Persistence**~~ (2026-07-25) — plan tier, finish action, grace period and recent
  directories survive restarts. Plain JSON, not the planned SQLite: nothing here is relational
  or large, so a flat file keeps dependencies at zero and stays hand-editable. Written via temp
  file + rename so a crash cannot truncate it. Session history is **not** persisted — Claude Code
  already owns the transcripts. The armed state is never restored, since silently re-arming a
  shutdown across a restart is exactly the wrong surprise.
- ~~**#9 Shortcuts**~~ / ~~**#10 Cross-platform**~~ (2026-07-25) — `Ctrl/⌘+1–9` jump,
  `Ctrl/⌘+⏎` approves the longest-waiting approval, `Ctrl/⌘+U` toggles usage; modifier and
  footer hints follow the platform the server reports. Per-OS command tables and path handling
  are unit-tested for both. See #13 — not yet *run* on macOS.
- ~~**Folder picker**~~ (2026-07-25, unplanned) — a Browse button opens the host's native folder
  dialog. It must be server-side: browsers never reveal filesystem paths, and
  `showDirectoryPicker` returns a handle, not a path. Pasting works too, including the quoted
  form Windows "Copy as path" produces, and a bad path is rejected up front with a readable
  message instead of failing obscurely inside the SDK.

- ~~**Finish chain**~~ (2026-07-25) — the single finish action became an ordered chain. Click
  actions in the order you want them; each step starts only when the previous reports success,
  and a failure stops the chain leaving the rest `skipped`. That ordering is the safety
  property: a failed push must never be followed by a shutdown. Verified live end to end —
  held while working, counted down, ran `notify → memory` in sequence with no overlap, and on
  an induced failure stopped with "1 of 2 steps — stopped at Save learnings".
- ~~**Save learnings action**~~ (2026-07-25) — a finish action that has Claude review the work
  and update its memory files, run as an SDK session rather than a shell command because
  deciding what was learned is judgement. Runs with `acceptEdits` so it works unattended.
  First attempt capped at 12 turns and failed after 140s; raised to 40, now completes in ~2
  minutes over ~17-29 turns and writes genuinely useful memories. Hitting the cap still fails
  the step deliberately — it may have written only half of what it intended.
- ~~**Launchers**~~ (2026-07-25) — `start-claudia.bat` and `start-claudia.command`, both
  double-clickable, both installing deps on first run and opening the browser. If Claudia is
  already running they open the existing instance rather than dying on the port clash — the
  failure hit twice while building.

- ~~**Stop sessions when the tab closes**~~ (2026-07-25) — when the last live browser goes away,
  sessions stop after a grace period (default 30s, adjustable, 0 to disable). A reload is well
  inside the grace, so refreshing never kills work.

  **A socket being open is not proof anyone is watching.** The first implementation went by
  socket state and never fired once: Firefox keeps a navigated-away page *and its WebSocket*
  alive in the back/forward cache. Found only by using the app — the unit tests and the
  feature's own logic were both "correct". Pages now send a heartbeat and a socket that stops
  beating counts as gone, which also covers sleeping laptops and dropped networks. The decision
  is a pure function (`client-liveness.ts`) so the case that fooled it is pinned by a test.

  Also fixed here: `/health` reported total sessions including stopped ones, which actively hid
  the bug — it now reports `live` separately.

### Findings from dogfooding (2026-07-25)

Running it for real, as the owner would, surfaced things no unit test did:

- The error banner never cleared. A stale "No such directory" sat on screen through several
  successful launches. Now dismissible, and any successful command retires it.
- Repos are not all under one root — some live under a synced folder. Mistyping a path is normal,
  which is why the Browse button and the recent-directories autocomplete earn their place.
- Four orphaned dev-server process trees had accumulated from manual restarts; `tsx watch`
  cannot rebind a held port, so each failed silently and left its npm wrapper alive. The
  launcher's already-running check exists for this.

- ~~**Sub-agent nesting**~~ (2026-07-25) — sub-agents appear as indented rows under the Task
  step, with agent type, live description, last tool, tokens and duration. No inference needed:
  the SDK tags progress with the spawning `tool_use_id` and reports the rest on its own channel.
  Cost is *not* broken out — the payload doesn't carry it, and inventing one would repeat the
  mistake the usage panel already corrected. The merge rule is the subtle part and is tested:
  progress carries usage but no final status, completion carries status but no usage.
- ~~**Clickable questions**~~ (2026-07-25) — `AskUserQuestion` arrives through `canUseTool` but
  is not a permission: the answer rides back as `updatedInput.answers`, keyed by question text.
  Rendered as a picker with the real options plus a free-text fallback. **Correction to an
  earlier claim in this file's history:** the tool *is* available in SDK sessions; a probe that
  said otherwise had failed to load it as a deferred tool.
- ~~**Waiting-on-you state**~~ (2026-07-25) — from `post_turn_summary`'s `needs_action`, so it is
  structured rather than guessed from prose. This also closed a safety hole: a session waiting on
  an answer reports `idle`, so the finish chain would have shut the machine down mid-conversation.
- ~~**Live permission switching**~~ (2026-07-25) — was silently broken. The SDK refuses to loosen
  in place ("not launched with --dangerously-skip-permissions"), exactly as a terminal does, and
  the toggle swallowed that error then reported success. Tightening applies live; loosening
  relaunches with `resume`, which preserves the whole conversation.
- ~~**Model visibility, fill-to-window board, multi-folder launch**~~ (2026-07-25) — chips read
  "Opus 5" / "Haiku 4.5" / "Opus 5 1M" instead of "claude"; Fill mode divides the window (2 →
  halves, 4 → quadrants); ctrl-clicking repos in Browse starts a session in each.

### Resolved decisions (2026-07-25, round 2)

- **Worktrees get one tile each** — no grouping layer, no special-casing. A worktree is just a
  session with its own cwd, which is already how the server treats it.
- **Single machine, two OSes** — see the scope correction above. Item 10 rewritten.
- **Plan tier is Max 20x but changes up and down**, so limits must be trivially switchable at
  runtime — a tier picker in settings, not a config-file edit or a rebuild.

### Owner gates

- None open.
