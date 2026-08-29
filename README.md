# Claudia

[![ci](https://github.com/pquarterman17/Claudia/actions/workflows/ci.yml/badge.svg)](https://github.com/pquarterman17/Claudia/actions/workflows/ci.yml)
[![licence: AGPL-3.0](https://img.shields.io/badge/licence-AGPL--3.0-blue.svg)](LICENSE)

One window over every Claude Code session running in parallel.

Sessions are **owned** by a local Node server via the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript.md), not scraped from
terminals. That means state is structured, not guessed: a permission prompt is a parked
`canUseTool` promise, and clicking Approve in the browser resolves it. A React UI shows every
session as a tile — live activity feed, nested sub-agents, approvals, questions as clickable
pickers — with a global sidebar for bulk control and a finish chain that can notify you, save
learnings to memory, or shut the machine down once everything settles.

Everything runs locally on `127.0.0.1`. Nothing is exposed to the network.

## Prerequisites

| Requirement | Notes |
| --- | --- |
| **Node.js ≥ 20.11** | Uses `import.meta.dirname`; Node 22/24 recommended |
| **npm** | Ships with Node; the repo uses npm workspaces |
| **Claude Code, installed and signed in** | Claudia launches sessions through the Agent SDK, which uses your existing Claude Code auth and plan — there is no separate API key |
| A browser | Anything modern; Firefox and Chrome are what it's been used with |

Sessions inherit your `~/.claude/settings.json` (permission allowlists etc.), so a command that
auto-approves in your terminal auto-approves here.

## Quick start

| Platform | Do this |
| --- | --- |
| **Windows** | Double-click `start-claudia.bat` |
| **macOS** | Double-click `start-claudia.command` (first time: right-click → Open if Gatekeeper objects) |
| **Linux** | `./start-claudia.command` (it is a plain bash script) |

Each launcher installs dependencies on first run, rebuilds the UI only if sources changed, and
opens the browser the moment the app answers — about **2 seconds** when the build is current.
If Claudia is already running it opens the existing instance instead of failing on the port.

Everything is served by **one process on `http://127.0.0.1:4317`**.

By hand, equivalently:

```bash
npm install
npm start        # build UI if stale, then serve app + API on 4317
```

Then: pick a working directory (paste a path, use a template chip, or hit **Browse** —
ctrl-click several folders to start a session in each), optionally type a first prompt, choose
a permission mode, **Launch**. A session launched with no prompt opens idle, costs nothing, and
waits for you.

## Platform support

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Core app (sessions, approvals, questions, usage) | ✅ verified | ✅ expected — same Node code | ✅ expected — same Node code |
| Folder picker | ✅ modern Explorer dialog | ✅ native `choose folder` | needs `zenity` installed |
| Finish actions (notify / sleep / shutdown / script) | ✅ verified | wired (`osascript`, `pmset`, `shutdown -h`) | wired (`notify-send`, `xset`, `shutdown -h`) |
| Keyboard modifier | Ctrl | ⌘ (auto-detected) | Ctrl |

**Honesty note:** development and end-to-end verification have all happened on Windows. The
macOS and Linux paths are unit-tested and CI runs the full suite on Ubuntu, but no human has
yet clicked through the app on either. The per-OS commands live in one table
([finish-actions.ts](server/src/finish-actions.ts)) and one picker script per platform
([folder-picker.ts](server/src/folder-picker.ts)) — if something misbehaves on your OS, it is
almost certainly in one of those two files.

Wrap-up script location: `~/bin/wrapup.sh` (macOS/Linux) or `C:\bin\wrapup.ps1` (Windows).

## Using it

- **Board** — every session is a tile: status, working dir, model chip
  ("Opus 5", "Haiku 4.5", "Opus 5 1M"), the reply **streaming live** as it is written, and a
  feed of reads/edits/commands with real durations
  and ✓/✕ outcomes, nested sub-agent rows with live token counts. Fill mode divides the window
  (2 sessions → halves, 4 → quadrants); Scroll mode gives fixed-height tiles you can drag-resize.
- **Sidebar** — a "Right now" digest (one line per session, things needing you sorted first)
  plus global control: the finish chain, grace periods, bulk approve/interrupt.
- **Approvals & questions** — permission prompts show Approve/Deny inline;
  `AskUserQuestion` renders as a step-through wizard, one question at a time like the
  terminal — picking an option advances, the last pick answers, free text works per question.
  A session that asked and is waiting counts as "needs you", not idle.
- **Finish chain** — stack actions that run in order once every session settles:
  Notify → Save learnings (Claude updates its memory files) → wrap-up script → sleep → shutdown.
  A failed step stops the chain; anything after it is skipped. Editing the chain disarms it.
  Destructive steps need a second confirming click, re-checked server-side.
- **Usage** — read from Claude Code's own local logs (covers your terminal sessions too).
  No API exposes real plan limits, so bars compare against a **typical day of your own history**
  by default, or ceilings you enter yourself under the Custom tier. Past the reference it shows
  the multiple ("14× of typical"), not a useless "0% left".
- **Notifications** — turn on **notify** in the header: desktop notification when a session
  blocks on approval, errors, or asks a question. Fires only on the transition, stays quiet
  while the window is focused.
- **Templates** — save a cwd + prompt + permission mode; relaunch from a chip.
- **Queued prompts** — type the next instruction mid-turn; the tile shows "N queued".
- **Closing the tab stops sessions** after a grace period (default 30 s; 0 disables). Pages
  heartbeat, so a reload never kills work but a genuinely closed tab does — even when the
  browser keeps the socket alive in its back/forward cache.

### Shortcuts

`Ctrl/⌘ K` command palette · `Ctrl/⌘ 1–9` jump to a session · `Ctrl/⌘ ⏎` approve the
longest-waiting approval · `Ctrl/⌘ U` usage panel. The modifier follows the host OS.

## Development

```bash
npm run dev        # two processes with hot reload: server on 4317, Vite UI on 4318
npm run typecheck  # tsc -b across all three workspaces
npm test           # server + web vitest suites
npm run build      # production UI bundle into web/dist
```

| Path | Role |
| --- | --- |
| `shared/src/index.ts` | WS protocol types — the single server/UI contract |
| `server/src/session.ts` | One SDK `query()` per session; owns the state machine |
| `server/src/message-router.ts` | Pure SDK-message → state/feed mapping |
| `server/src/approval-gate.ts` | Parks `canUseTool` until the UI answers |
| `server/src/question-parser.ts` | Reads `AskUserQuestion` into a picker |
| `server/src/sub-agent-tracker.ts` | Merges sub-agent progress into its parent step |
| `server/src/trigger-engine.ts` | The finish chain: arm → countdown → run in order |
| `server/src/finish-actions.ts` | Per-OS command table |
| `server/src/usage-reader.ts` | Incremental streaming reader for `~/.claude` JSONL logs |
| `server/src/plan-limits.ts` | Token weighting + the self-derived usage baseline |
| `server/src/settings-store.ts` | Preferences, atomically written to `~/.claudia/settings.json` |
| `web/src/store.ts` | One WS connection; immutable snapshots; heartbeat |
| `web/src/palette.ts`, `shortcuts.ts`, `layout.ts` | Pure UI logic, unit tested |
| `web/src/components/` | One component per job |
| `server/test/fake-query.ts` | Fake SDK query: drives session lifecycle vectors deterministically |
| `plans/MAIN_PLAN.md` | The authoritative work list |

### Conventions

- **Size ratchet** — every source `.ts`/`.tsx` stays under 400 lines, enforced by
  `server/test/repo-integrity.test.ts`. Never raise it; split the file.
- **State comes from structured SDK events**, never from parsing prose.
- **Usage numbers come only from `result.modelUsage`** — assistant-message usage is a
  placeholder (measured 1 vs a real 306) and cache reads double-count within a turn.
- Anything decision-shaped lives in a pure module with unit tests; I/O classes stay thin.
- Commits: `feat(scope): imperative lowercase`.

### End-to-end checks (server must be running)

```bash
node scripts/smoke.mjs "C:/path/to/repo" "Run bash: docker --version"   # approval round-trip
node scripts/chain-test.mjs                                             # full finish chain
npx tsx scripts/memory-test.mjs "C:/path/to/repo"                       # Save-learnings action (~2 min)
```

Use forward slashes in these paths — most shells eat backslashes.

## Troubleshooting

- **"Not connected" in the header** — the server died or the port is squatted. Check
  `http://127.0.0.1:4317/health`; `live` counts sessions still holding a process.
- **Port 4317 already in use** — a previous instance is still up (the launcher would have
  reused it). Find it: `netstat -ano | findstr 4317` (Windows) / `lsof -i :4317` (macOS/Linux).
- **Browse does nothing on Linux** — install `zenity`.
- **Every tool call asks for approval** — that's `default` mode doing its job; launch with
  `Auto` (the default) or toggle "skip perms" on the tile. Loosening a *running* session
  restarts it under the hood with the conversation preserved — that's an SDK restriction, the
  same one `claude` has in a terminal.
- **The usage bars look wrong** — they are estimates from local logs, by design; other
  machines' usage is invisible. See the note inside the panel.

## Two agents on one board

A tile can run **Claude Code** (the default) or **OpenAI Codex**. Pick the agent in the launch
bar; Codex tiles carry a badge so a glance is enough to tell them apart.

Codex is driven through `codex app-server`, its JSON-RPC interface — not the `@openai/codex-sdk`
package, which sets an approval policy but exposes no approval callback, so a UI cannot decide
per command with it. The app-server sends `execCommandApproval` and `applyPatchApproval` as
requests, which park exactly like a Claude `canUseTool` call, so approvals work the same way in
the same banner.

To use it:

```bash
npm install -g @openai/codex
```

then sign in to Codex once. Verify end to end with `node scripts/codex-smoke.mjs
"C:/path/to/a/repo"` — a passing run shows the full supervision loop, including an approval
parked in Claudia and released from the browser:
`starting -> working -> awaiting_approval -> working -> idle`.

Verified against codex-cli 0.151.0 on Windows. Two things worth knowing if you read the
protocol docs yourself: this CLI sends `item/commandExecution/requestApproval`, not the
documented `execCommandApproval`, and the two generations answer with different vocabularies
(`accept`/`decline` versus `approved`/`denied`) — Claudia handles both. On Windows npm installs
`codex` as a `.cmd` shim with no `.exe` on PATH, so the binary is resolved on the filesystem
rather than left to `spawn`, which cannot execute either PATH entry.

**Resume and fork work for Codex too.** The Resume history panel lists both agents' past
conversations for a folder, tagged so you can tell them apart, and each row resumes or forks
with the agent that wrote it. One Codex-specific rule, learned the hard way: a Codex thread has
a single writer, so resuming one that is still open in another tile is refused — fork it
instead, which works even while the original runs.

**Model choice works for Codex too** — the same picker as Claude. `model/list` enumerates what
your install offers and `turn/start` takes a per-turn `model`, so a switch lands on the next
turn exactly as it does for Claude.

**What a Codex tile does not have**, measured rather than assumed: no dollar cost (it reports
token counts only), no `/cost` or `/context`, no MCP panel, effective-settings inspector, or
file-checkpoint rewind. Those controls are hidden or disabled with the reason
attached rather than left in place to silently do nothing. Its sub-agents are separate threads,
so they appear as their own feed entries rather than nested inside the call that spawned them.

## Security

Claudia can launch sessions that read, write, and run commands — so "it only listens on
`127.0.0.1`" is not, by itself, an access control. Two attacks get past a loopback bind and
both are blocked explicitly:

- **Cross-origin WebSocket.** Browsers do not apply the same-origin policy to WebSockets —
  no preflight, no CORS — so any page you have open could otherwise connect and send
  `launch_session`. The `Origin` header must be a loopback host, or the upgrade gets a 401.
- **DNS rebinding.** An attacker domain pointed at `127.0.0.1` looks same-origin to the
  browser, but still names itself in `Host`. A non-loopback `Host` gets a 403 before any
  handler runs.

Both live in [origin-guard.ts](server/src/origin-guard.ts) with tests. Subprocesses use
`execFile` with argument arrays (never a shell string), static paths cannot escape the build
directory, and Claudia stores no credentials of its own — it uses the Claude Code auth
already on the machine.

Full threat model, the parts that are dangerous by design, and how to report a
vulnerability: **[SECURITY.md](SECURITY.md)**.

## Status

Personal tool, built fast and verified as it grew: 354 unit tests plus scripted live
end-to-end checks. Windows is the daily driver; macOS/Linux passes welcome. Not yet public.

## License

[AGPL-3.0-only](LICENSE). Use it, fork it, sell it if you like — but modifications have to stay
open, and under the AGPL that includes ones only ever offered **over a network**, which is how
anyone would realistically run a tool like this. A permissive licence would have let a fork be
closed and hosted; that is the case this one is chosen to cover.

If you deploy a modified copy for anyone but yourself, section 13 requires you to offer them its
source. The footer link is already there for that reason — point it at your fork.
