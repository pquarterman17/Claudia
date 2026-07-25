# Conductor — plan

One window over every Claude Code session running in parallel, on macOS and Windows.
Design prototype: `Conductor.dc.html` (in this project). This document is the build plan
for the repo that will live in the `Claudia/` folder.

---

## 1. Problem

2–6 terminals of Claude Code run at once, usually on different projects and sometimes on
different machines. Today that means hunting through terminal tabs to find which session is
blocked on a permission prompt, no aggregate view of spend against plan limits, and no way to
say "when all of this is finished, shut the machine down".

## 2. What Conductor is

A desktop app that owns the terminals rather than watching them. Each session is a real PTY
running `claude` in a project directory; Conductor renders it, drives it, and reports on it.

Non-goals for v1: editing files, replacing the terminal for non-Claude work, team/multi-user
features, mobile.

## 3. Product surface (as prototyped)

**Layouts** — Grid (all sessions live), Focus (session rail + one large terminal), Stack.

**Per-session tile**
- Header: status dot, project name, git branch + dirty count, short status token
  (`run` / `wait` / `err` / `idle`), elapsed time, `host · model` chip.
- Body: two views, toggled per tile — `term` (real terminal output) and `feed`
  (abstracted steps: reads, edits, commands, results, with durations).
- Inline approval banner for permission prompts (Approve / Deny).
- Composer row: prompt input, `skip perms` toggle, context-remaining bar, share-of-plan bar.

**Conductor tile (global controller)**
- Aggregate: `settled / total`, segmented bar of working / awaiting / blocked / idle, time-to-quiet.
- Host scope: Both hosts / macbook-pro / win-desktop, with busy counts; out-of-scope tiles dim
  and every global action respects the scope.
- *When everything finishes*: Notify · Commit + push all · Sleep displays · Shut down hosts ·
  Run wrap-up script. Shows the actual per-OS command. Arm/disarm with a visible 30s countdown;
  never fires while any in-scope session is blocked or awaiting approval.
- *New sessions launch with*: Ask each time · Auto-accept edits · Skip all permissions
  (`--dangerously-skip-permissions`), plus `+ Launch`.
- Bulk: approve all, pause all, resume all, retry blocked.

**Usage**
- Header strip: today's spend, tokens, burn rate, sparkline, and "plan left" for the tightest window.
- Expanded panel: remaining-percentage bars for the 5-hour session window, weekly all-models and
  weekly Opus; per-project spend/tokens/share-of-plan; plan-limits table (used / limit / remaining / resets).

**Safety**
- Any session running unprompted is marked red (chip + top stripe on the tile) and the controller
  shows a banner with one-click "Require approvals" across all sessions.
- Destructive finish actions (shutdown) require an explicit confirm before arming.

## 4. Architecture

```
┌─────────────────────────── Conductor app (Tauri v2) ───────────────────────────┐
│  UI: TypeScript + React, xterm.js per session, layout/usage/controller views   │
│  Core (Rust): session registry, PTY supervisor, usage reader, trigger engine   │
└───────────────┬───────────────────────────────────────────────┬───────────────┘
                │ local IPC                                     │ mTLS over LAN
        ┌───────┴────────┐                              ┌───────┴────────┐
        │ local sessions │                              │ conductor-agent│
        │  (this host)   │                              │  (other host)  │
        └────────────────┘                              └────────────────┘
```

- **Shell**: Tauri v2 — one Rust core, native builds for macOS (universal) and Windows (MSI).
- **Terminals**: `portable-pty` in Rust; ConPTY on Windows, forkpty on macOS. Output streamed to
  the UI in chunks; `xterm.js` renders, `xterm-addon-serialize` snapshots for the feed view.
- **Feed view**: derived from the same stream — a parser recognises Claude Code's tool-call
  framing and emits structured steps; the raw buffer stays authoritative.
- **Usage**: read Claude Code's own session logs (`~/.claude/projects/**/*.jsonl`,
  `%USERPROFILE%\.claude\...` on Windows) with a file watcher; aggregate tokens and cost per
  project and per rolling window. No scraping of the UI, no separate accounting.
- **Plan limits**: user-configured (5-hour window, weekly all-models, weekly Opus). Remaining
  percentages are computed against those; thresholds colour the bars (<35% amber, <15% red).
- **Remote hosts**: `conductor-agent`, the same Rust core headless. Pairing by QR/code on the LAN,
  mTLS with pinned certs, heartbeat every 2s. The agent owns PTYs on its host and executes finish
  actions locally.
- **Finish actions**: per-OS command table, executed by whichever agent owns the host.
  - sleep: `pmset displaysleepnow` / `rundll32 user32.dll,LockWorkStation`
  - shutdown: `shutdown -h now` / `shutdown /s /t 0`
  - wrap-up: `~/bin/wrapup.sh` / `C:\bin\wrapup.ps1`
- **Persistence**: SQLite — sessions, per-session history, usage rollups, settings.

### Session state machine

`starting → working → awaiting_approval → working → idle`, with `error` reachable from any state
and `stopped` terminal. A session is *settled* only in `idle`. Status is inferred from the stream
(prompt patterns, tool-call framing, exit codes), never guessed from timing alone.

### Trigger engine

Armed + all in-scope sessions settled → countdown (default 30s, cancellable) → execute the action
on each in-scope host → record the result. Blocked or awaiting-approval sessions hold the trigger
and the reason is shown. Triggers are one-shot; firing disarms.

## 5. Cross-platform notes

| Concern | macOS | Windows |
| --- | --- | --- |
| PTY | forkpty | ConPTY (Win 10 1809+) |
| Paths | `~/code/x` | `D:\src\x` — normalise for display, keep native for exec |
| Modifier | ⌘ | Ctrl |
| Window chrome | traffic lights | caption buttons |
| Shell | zsh | PowerShell 7 (pwsh) default, cmd fallback |
| Notifications | `osascript` / native | native toast |
| Autostart | LaunchAgent | Task Scheduler |
| Shutdown perms | may need admin | may need admin |

Path display, key hints and chrome all follow the host the window is on; per-session chips show
which host each session actually runs on.

## 6. Milestones

**M0 — spike (1 week)** — Tauri shell, one PTY running `claude`, xterm.js round-trip, input works.

**M1 — multi-session local (2 weeks)** — session registry, Grid/Focus/Stack, status inference,
inline approvals, composer, launch modes including `--dangerously-skip-permissions`.

**M2 — usage (1 week)** — JSONL reader + watcher, header strip, expanded panel, plan limits and
remaining-percentage bars.

**M3 — controller (1 week)** — aggregate state, bulk actions, finish actions, arm/countdown/fire
on the local host, confirm gate for destructive actions.

**M4 — second host (2 weeks)** — `conductor-agent`, pairing, mTLS transport, host scoping,
remote PTYs, remote finish actions, heartbeat and reconnect UI.

**M5 — polish (1–2 weeks)** — `⌘K`/`Ctrl+K` palette, OS notifications when a session needs you,
diff peek per session, per-project auto-approve rules, session history, signed builds + updater.

## 7. Risks

- **Status inference is heuristic.** Mitigate by parsing Claude Code's structured output where
  available and treating unknown states as "needs you" rather than idle.
- **A shutdown trigger is only as good as the link.** Agent heartbeat is a first-class signal;
  a stale agent blocks the trigger and says so.
- **ConPTY quirks** (resize, ANSI gaps) — budget spike time in M0 on Windows, not just macOS.
- **Log format drift** in `~/.claude` — version the reader, degrade to token-only display.
- **Skip-permissions blast radius** — always visible, one-click revocable, never the default,
  and recorded in session history.

## 8. Open questions

1. Real plan limits to calibrate the remaining bars (current placeholders: $12 / 5h, $40 weekly,
   $14 Opus weekly).
2. Sessions started outside Conductor — attach to existing terminals, or Conductor-launched only?
3. Worktrees: one tile per worktree, or grouped under a project?
4. Should the wrap-up script be per-project rather than per-host?
5. Windows host mostly headless, or worked at directly? Affects whether it needs the full UI.
