# Claudia

One window over every Claude Code session running in parallel.

Sessions are **owned** by a local Node server via the Claude Agent SDK, not scraped from
terminals. That means state is structured, not guessed: a permission prompt is a parked
`canUseTool` promise, and clicking Approve in the browser resolves it.

## Run it

Double-click **`start-claudia.bat`** on Windows or **`start-claudia.command`** on macOS. Either
one installs dependencies on first run, starts both processes, and opens the browser — and if
Claudia is already running it just opens the existing instance instead of failing on the port.

Or by hand:

```bash
npm install
npm run dev
```

Server on `127.0.0.1:4317`, UI on `127.0.0.1:4318`. Open the UI, pick a working directory
(paste a path or hit Browse), type a first prompt, choose a permission mode, hit Launch.

## Layout

| Path | Role |
| --- | --- |
| `shared/src/index.ts` | WS protocol types — the server/UI contract |
| `server/src/session.ts` | One SDK `query()` per session; owns state |
| `server/src/message-router.ts` | Pure SDK-message → state/feed mapping (unit tested) |
| `server/src/approval-gate.ts` | Parks `canUseTool` until the UI answers (unit tested) |
| `server/src/session-manager.ts` | Registry + feed history |
| `server/src/gateway.ts` | WS fan-out and command dispatch |
| `server/src/tool-tracker.ts` | Matches tool results to their calls by id (unit tested) |
| `server/src/trigger-engine.ts` | Fires a finish action once every session settles (unit tested) |
| `server/src/finish-actions.ts` | Per-OS command table for those actions |
| `server/src/folder-picker.ts` | Native folder dialog + path cleaning (unit tested) |
| `server/src/usage-reader.ts` | Incremental streaming reader for Claude Code's JSONL logs |
| `server/src/usage-store.ts` | Bucketed rolling usage; window maths (unit tested) |
| `server/src/plan-limits.ts` | Token weighting and the self-derived baseline (unit tested) |
| `server/src/settings-store.ts` | Preferences on disk, atomically written (unit tested) |
| `web/src/shortcuts.ts` | Keyboard model, platform-aware (unit tested) |
| `web/src/components/` | One component per job — tile, feed, approval, launch, topbar, controller, usage |
| `design/conductor-prototype/` | The Claude Design prototype this is built from (named "Conductor" at design time; the app is Claudia) |
| `plans/MAIN_PLAN.md` | Tiered plan; the authoritative work list |

## Conventions

- **Size ratchet**: every `.ts`/`.tsx` file stays under 400 lines
  (`server/test/repo-integrity.test.ts`). Never raise it — split the file instead.
- **State comes from SDK events**, never from parsing output text.
- **Usage comes only from `result.modelUsage`.** Assistant-message `usage` is a placeholder
  (measured 1 against a real 306) and its cache-read counts double-count within a turn.
  `modelUsage` is cumulative per session, so assign it — never add.
- Sessions inherit your `~/.claude/settings.json` allowlist, so the same commands
  auto-approve here as in your terminal. Everything else surfaces as an approval.

## Usage

The panel reads Claude Code's own session logs, so it counts your terminal sessions too — not
just the ones Claudia launched. It resumes each log from the last byte offset it read, so the
first pass over ~80 MB takes about half a second and every later one about 20 ms.

**There is no API for real plan limits.** No CLI flag, no SDK method, no documented endpoint;
even `/usage` computes from local history. So by default the bars compare against *a typical
day of your own* rather than an invented ceiling — self-calibrating, and honest about what it
knows. Past that reference it shows the multiple ("14× of typical") instead of "0% left",
because that distinguishes slightly-busy from unusually-busy. Tier buttons are available as an
override and are labelled as estimates.

Cache reads are weighted at 10%, as billing weights them; counted raw they dwarf everything
else and any total becomes meaningless.

## Shortcuts

`Ctrl/⌘ 1–9` jump to a session · `Ctrl/⌘ ⏎` approve the longest-waiting approval ·
`Ctrl/⌘ U` toggle usage. The modifier follows the host the server reports.

## The finish chain

Pick what happens when every session settles. Actions stack: click them in the order you want
them to run, and each step starts only once the previous one reports success.

    1. Save learnings  →  2. Wrap-up script  →  3. Shut down host

**A failure stops the chain.** Anything after a failed step is marked skipped and never runs —
that ordering is the safety property. If a push fails, the shutdown behind it must not fire and
quietly lose the work.

Any session that needs you — awaiting approval, or errored — **holds** the trigger and cancels
an in-flight countdown; it restarts from full when the session clears, never from where it left
off. An empty app never fires. A chain containing a destructive step needs a second confirming
click before it can be armed, and the server re-checks that rather than trusting the UI. Editing
the chain always disarms, so a countdown can never carry over onto different steps. Once the
chain starts it runs to completion — a half-run chain is worse than a finished one.

Available: **Notify me** · **Save learnings** (Claude reviews the work and updates its memory
files) · **Wrap-up script** · **Sleep displays** · **Shut down host**. *Commit + push* is
deliberately disabled until there are rules for which repos qualify and what to do with a dirty
tree — better a struck-through button than one that silently does nothing.

## Checks

```bash
npm run typecheck && npm test
```

End-to-end against a live session (server must be running):

```bash
node scripts/smoke.mjs "C:/path/to/repo" "Run bash: docker --version"
```

Drive a whole finish chain — builds it, arms it, launches a session, reports each step:

```bash
node scripts/chain-test.mjs
```

The memory action on its own, since it is the slow one (~2 minutes):

```bash
npx tsx scripts/memory-test.mjs "C:/path/to/repo"
```

Use forward slashes in paths for these — backslashes get eaten by most shells.
