# Claudia (Conductor) — Main Plan

One window over every Claude Code session running in parallel. Sessions are owned by a local
Node server via the Claude Agent SDK (`query()`), rendered in a React web UI at localhost.
Supersedes the Tauri+PTY plan drafted during design (kept for reference at
`design/conductor-prototype/PLAN.md`; its product surface carries over, its PTY architecture
does not).

**Status:** Active
**Created:** 2026-07-25
**Updated:** 2026-07-25

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
- `web/` — Vite + React. Ports the prototype UI (`design/conductor-prototype/Conductor.dc.html`):
  Grid/Focus/Stack, session tiles with feed view, approval banners, controller tile, usage panel.
  Design tokens from Nocturne (`design/conductor-prototype/_ds/.../styles.css`).
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

Conductor supervises sessions on **one machine at a time**. The owner works from a Windows
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

## Tier 1 — High Impact

2. **Session lifecycle** — resume from `claudeSessionId`, per-session model picker, interrupt
   button in the UI (server + protocol already support interrupt/stop)
3. **Feed view fidelity** — map tool_use/tool_result to the prototype's step feed (icon, title, meta, duration); raw message log as fallback view

## Tier 2 — Medium Impact

4. **Controller tile** — aggregate settled/total, segmented status bar, bulk approve/pause, launch-mode selector (ask / acceptEdits / bypassPermissions with red warnings)
5. **Usage panel** — JSONL watcher + SDK result aggregation; today's spend, burn rate, per-project rows; user-configured plan limits with remaining bars
6. **Persistence** — SQLite (better-sqlite3): sessions, history, usage rollups, settings
7. **Trigger engine** — arm/countdown/fire (notify → commit+push → sleep → shutdown → script), per-OS command table, blocked-session gate
8. **Hooks monitor tier** — global hook POSTs to server so plain-terminal sessions appear as read-only tiles

## Tier 3 — Nice-to-Have

9. **Palette + shortcuts** — Ctrl/⌘K, Ctrl+1..6 jump, Ctrl+⏎ approve
10. **Cross-platform correctness** — runs natively on Windows and macOS (not federated between
    them). Path display normalised but native for exec, per-OS shell, notifications, and the
    finish-action command table (`pmset` vs `rundll32`, `shutdown -h` vs `shutdown /s`).
    Verify on both machines rather than treating it as one milestone.
11. **Tauri wrap** — native window/tray/notifications around the web UI
12. **Diff peek + per-project auto-approve rules**

## Completed

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
- **Repo is `Claudia/`**, design prototype preserved under `design/conductor-prototype/`.

### Gotchas found the hard way

- **Pin the SDK to `^0.3.x`.** `^0.1.0` resolves to 0.1.77, where *every* tool call dies with
  `tool_use ids must be unique`. Cost an hour; the fix is the version, not the code.
- Sessions inherit `~/.claude/settings.json` (81 allow rules here), so most Bash commands
  auto-approve. To exercise the approval path, use something outside the allowlist (`docker`).

### Resolved decisions (2026-07-25, round 2)

- **Worktrees get one tile each** — no grouping layer, no special-casing. A worktree is just a
  session with its own cwd, which is already how the server treats it.
- **Single machine, two OSes** — see the scope correction above. Item 10 rewritten.
- **Plan tier is Max 20x but changes up and down**, so limits must be trivially switchable at
  runtime — a tier picker in settings, not a config-file edit or a rebuild.

### Owner gates

- None open.
