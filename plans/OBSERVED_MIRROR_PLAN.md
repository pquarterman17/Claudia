# Mirroring sessions Claudia did not launch

Status: proposed. Depends on nothing in the fleet stack (#40/#41/#42); can land
before or after it.

## Where this starts

Claudia can already **see** terminal sessions it did not launch. `hook-install.ts`
writes a global `type: "http"` hook into `~/.claude/settings.json`, every Claude
Code session on the machine POSTs its events to `/hooks`, and `hook-monitor.ts`
folds them into an `ObservedSession`. `ObservedStrip.tsx` renders them below the
board, deliberately outside the grid, because "these cannot be launched,
approved, interrupted or prompted".

That is the right shape and it should not change. What is thin is the content.
An `ObservedSession` is eight fields, two of them clamped to 160 characters:

```
id, cwd, state, startedAt, lastEventAt, source,
lastPrompt?, lastTool?, lastMessage?, needs?, permissionMode?, endReason?
```

So the board can tell you *that* a terminal session is working, on which
directory, and what tool it last touched. It cannot show you what it is doing.

Meanwhile `usage-reader.ts` already streams **every** Claude transcript on the
machine — `~/.claude/projects/**/*.jsonl` — line by line, resuming each file from
the byte offset last read, and it does this for token accounting because those
logs are trustworthy where the SDK's streaming counts are not. The detail is
already flowing through this process. It is being summed and thrown away.

This plan joins the two.

## The join

Transcripts are named for the session: `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.
The `session_id` on every hook payload is that same id, and it is also the id
`hook-monitor.list()` already excludes owned sessions by. So the hook stream and
the transcript file are two views of one session with a key that needs no
inference.

Two channels, two jobs:

- **Hooks stay the liveness channel.** Push, sub-second, and the only source for
  `needs_you` — a permission prompt never reaches the transcript, because the CLI
  is blocked waiting on it. State transitions keep coming from the event *name*.
- **The transcript becomes the detail channel.** Pull, on demand, and the only
  source of the actual conversation.

Neither replaces the other. A design that tried to serve the tile from the
transcript alone would lose `needs_you` entirely, which is the one state a human
has to act on.

## What the transcript actually contains

Verified against a real 9,616-line transcript on this machine rather than taken
from documentation — the same discipline `hook-monitor.ts` used, and for the same
reason: it found four documented field names that were wrong.

Top-level `type` values observed, by frequency:

| type | count | use |
| --- | --- | --- |
| `assistant` | 3348 | model turns |
| `attachment` | 2255 | CLI-internal |
| `user` | 1936 | prompts **and tool results** |
| `last-prompt` | 523 | CLI-internal |
| `queue-operation` | 518 | CLI-internal |
| `atis-latch` | 479 | CLI-internal |
| `mode` | 450 | CLI-internal |
| `system` | 107 | hook results, stop reasons |

Content blocks inside `user`/`assistant`, by frequency:

| record | block | count |
| --- | --- | --- |
| assistant | `tool_use` | 1788 |
| user | `tool_result` | 1787 |
| assistant | `thinking` | 867 |
| assistant | `text` | 694 |
| user | bare string | 149 |
| user | `text` | 1 |

Which maps onto `TranscriptItem` with nothing left over:

- `user` with a bare-string or `text` content → `kind: 'user'`
- `assistant` `text` → `'assistant'`
- `assistant` `thinking` → `'thinking'`
- `assistant` `tool_use` → `'tool_use'`, `toolName` from `block.name`
- `user` `tool_result` → `'tool_result'`

And onto `FeedStep` with enough to build a real one, not a placeholder:

- `tool_use.id` pairs with the later `tool_result.tool_use_id`, so a step can
  start `'running'` and be patched to `'ok'` / `'error'` from `is_error` — the
  same lifecycle owned sessions already have.
- Both records carry `timestamp`, so `durMs` is a subtraction rather than a guess.
- `isSidechain: true` marks sub-agent traffic, which is what `FeedStep.subAgents`
  is for.
- `cwd`, `gitBranch`, `permissionMode` and `version` ride on every message record.

Three cautions found in the same pass:

1. **Several record types carry no `timestamp` at all.** `atis-latch`, `mode` and
   `last-prompt` have only `sessionId` and `type`. A reader that assumes a
   timestamp will produce `NaN` sort keys. Skip by `type` allowlist, not by
   trying and failing to parse.
2. **`tool_result` lives on a `user` record.** A reader that treats `type: 'user'`
   as "something a human typed" will render 1,787 tool outputs as prompts. This
   is exactly the mistake `saved-sessions.ts` already guards against with
   `isTypedPrompt`.
3. **The CLI-internal types are 4,225 of the 9,616 lines** — nearly half. The
   allowlist is what keeps the parse cheap.

## The bug this must fix first

`usage-reader.ts:93` cannot be reused as it stands:

```ts
const start = size < previous ? 0 : previous;
if (size === start) return;
this.offsets.set(path, size);          // <-- advanced before reading
const stream = createReadStream(path, { start, end: size - 1, ... });
```

The offset is advanced to `size` unconditionally. When the last line is only
partially written — which is the normal state of a file being appended to by a
live session — `readline` still emits that fragment, `JSON.parse` fails, and the
record is dropped. The next scan starts at `size`, i.e. the middle of that line,
so the remainder parses as garbage too. The record is lost permanently.

The comment there says "a partially-written trailing line; the next scan re-reads
it". It does not; the offset has already moved past it.

For token accounting this is a rare, small undercount and nobody would notice.
For a mirror it is a dropped message in the middle of a conversation — and it
would happen most often on exactly the sessions being watched live, because those
are the ones with a partial tail. The fix is to advance the offset to the last
**complete newline** consumed rather than to the file size. That is a small,
self-contained change to `usage-reader.ts` with its own test, and it improves the
existing usage numbers as a side effect.

**This should land as its own commit before any mirror code**, so the fix is
reviewable on its own and does not arrive buried in a feature.

## Design

### Pull, not sweep

Do not mirror every session all the time. `usage-reader` sweeps because it needs
totals across the machine; a mirror needs one conversation, the one a human just
opened. So: a client asks to mirror session `X`, the server reads `X`'s file
incrementally while that subscription is open, and stops when it closes.

This bounds the whole feature. The expensive version — parse every line of every
recent transcript into feed steps and hold them in memory — is the version that
makes the 736 MB of logs the reader already warns about into a real problem.

### New module: `server/src/observed-transcript.ts`

Owns: given a session id and its file path, produce `TranscriptItem[]` and
`FeedStep[]`, and keep producing them incrementally while subscribed.

It should **not** own file discovery — that is `usage-reader`'s existing
`recentFiles` walk, which should be lifted into a shared helper rather than
duplicated. One walk of `~/.claude/projects`, two consumers.

Rough shape:

```ts
export interface MirrorSlice {
  transcript: TranscriptItem[];
  feed: FeedStep[];
  patches: Array<{ stepId: string; patch: FeedStepPatch }>;
  /** Byte offset to resume from; see the offset bug above. */
  offset: number;
}
export function readMirror(path: string, from: number): MirrorSlice;
```

Pure and synchronous over a byte range, so it is testable against a fixture file
without a live CLI — which matters, because everything else in this area needed a
live CLI to verify.

### Protocol

Three commands and two events, following the existing `observed_sessions`
precedent:

- `mirror_session { sessionId }` → server begins reading, replies `mirror_opened`
  with the backlog (capped, see below), then streams
- `mirror_step { sessionId, step }` / `mirror_patch { sessionId, stepId, patch }`
- `close_mirror { sessionId }`

`mirror_unavailable { sessionId, reason }` when there is no transcript — a remote
session, a deleted file, an unreadable directory. This must be a normal answer,
not an error: `saved-sessions.ts` already documents that everything reading
another process's files has to degrade to "nothing to show" rather than take the
server down.

### Backlog cap

A 9,616-line transcript is not a payload. Send the tail — a few hundred steps;
`FEED_CAP` is 500 for owned sessions and a read-only mirror needs no more — and
say how many were elided. A "load earlier" command can follow later if anyone asks for it; it should
not be in the first version.

### UI

`ObservedTile` gains an expand affordance; expanded, it shows the mirrored feed in
the existing feed component, read-only. The strip's own argument holds and gets
*stronger*: a mirror that looks exactly like an owned session but silently
discards typed input would be worse than today's honest thin tile. So the
expanded view needs a visible, permanent read-only marker, and no composer.

## What stays impossible

State this in the PR body, because it is the question a reviewer will ask:

- **No input, ever.** The SDK's `query()` owns a child process over stdio; there
  is no attach-to-existing-process API. `hook-monitor.ts` already says this in its
  own words: "there is no attach path to a live CLI".
- **No answering approvals.** Hooks report `permission_prompt` as `needs_you`, but
  the CLI owns that prompt and is blocked on its own stdin.
- **Nothing without a local transcript.** Claude Code on the web, and any session
  on another machine, has neither a local JSONL nor a local hook. Invisible to
  both channels. Worth saying out loud in the UI's empty state rather than leaving
  a user wondering why their web session is missing.
- **Adoption remains the interactive path.** `resumeSavedSession`
  (`launch-session.ts:58`) already takes any session id from `listSessions()`,
  terminal ones included, and gives full interactivity — but as a take-over, not a
  mirror, so the original must be finished. Mirror is for watching something that
  is still running; resume is for inheriting something that has stopped.

## Sequencing

1. Fix the offset bug in `usage-reader.ts`, with a test that a record split across
   two scans survives. Self-contained; improves usage accuracy on its own.
2. Lift `recentFiles` into a shared discovery helper. No behaviour change.
3. `observed-transcript.ts` + tests against a committed fixture transcript. No
   wiring. Pure parse, verifiable without a CLI.
4. Protocol + gateway subscription + prune on disconnect.
5. UI.

Steps 1–3 are worth landing whether or not 4–5 ever do: the bug is real today, and
a tested transcript parser is the piece that makes anything else in this area
cheap.

## Costs to weigh before starting

- **`gateway.ts` is at 386 lines against the 400-line ratchet.** Subscription
  bookkeeping will not fit. Expect to split it first, the way `session-queries.ts`
  was split out — that is a prerequisite, not a surprise.
- **Per-subscription file reads on a timer** are new recurring work. Bounded by
  "only while a human is looking", but it is a second thing polling the disk.
- **Two sources of truth for one tile.** Hooks say `working`; the transcript's
  last record may lag. They will disagree, briefly and routinely. Decide the rule
  once and write it down: hooks win on *state*, transcript wins on *content*.
