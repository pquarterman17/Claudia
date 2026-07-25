# Claudia

One window over every Claude Code session running in parallel.

Sessions are **owned** by a local Node server via the Claude Agent SDK, not scraped from
terminals. That means state is structured, not guessed: a permission prompt is a parked
`canUseTool` promise, and clicking Approve in the browser resolves it.

## Run it

```bash
npm install
npm run dev
```

Server on `127.0.0.1:4317`, UI on `127.0.0.1:4318`. Open the UI, enter a working directory
and a first prompt, pick a permission mode, hit Launch.

## Layout

| Path | Role |
| --- | --- |
| `shared/src/index.ts` | WS protocol types — the server/UI contract |
| `server/src/session.ts` | One SDK `query()` per session; owns state |
| `server/src/message-router.ts` | Pure SDK-message → state/feed mapping (unit tested) |
| `server/src/approval-gate.ts` | Parks `canUseTool` until the UI answers (unit tested) |
| `server/src/session-manager.ts` | Registry + feed history |
| `server/src/gateway.ts` | WS fan-out and command dispatch |
| `server/src/trigger-engine.ts` | Fires a finish action once every session settles (unit tested) |
| `server/src/finish-actions.ts` | Per-OS command table for those actions |
| `web/src/components/` | One component per job — tile, feed, approval, launch, topbar, controller |
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

## The finish trigger

Pick what happens when every session settles, then arm it. It fires once and disarms.

Any session that needs you — awaiting approval, or errored — **holds** the trigger and
cancels an in-flight countdown; it restarts from full when the session clears, never from
where it left off. An empty app never fires. Shutdown is marked destructive and needs a
second click to confirm before it can be armed, and the server re-checks that confirmation
rather than trusting the UI.

## Checks

```bash
npm run typecheck && npm test
```

End-to-end against a live session (server must be running):

```bash
node scripts/smoke.mjs "C:/path/to/repo" "Run bash: docker --version"
```
