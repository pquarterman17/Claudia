import { currentRunFor, type FleetEvent } from '@claudia/shared';
import type { FleetStore } from '../store/index.js';

/**
 * Accepting a task against the evidence, rather than because somebody clicked.
 *
 * `reported -> accepted` was a plain status move: the transition table allowed
 * it, so the board offered it, and the store wrote it. Nothing on that path
 * ever read the judgement the pulse had just made — so a task whose checks
 * failed, whose diff was empty, or which had never been judged at all could be
 * accepted with one click, and the record afterwards said only that its status
 * was `accepted`.
 *
 * That is the whole completion contract undone at the last step. `reported`
 * and `accepted` are separate states BECAUSE a child's claim is untrusted and
 * something has to check it; a human clicking accept without reading is the
 * same unchecked claim with a person's name on it.
 *
 * So acceptance is its own command, and it reads the judgement. The bar is
 * exactly the one `judge` reports: nothing failed, and nothing is missing.
 *
 * An OVERRIDE is possible, and has to be, or a mission can wedge: a verify
 * command that is wrong rejects good work, and judging happens once per run,
 * so re-judging is not a way out. It costs a reason, and the reason goes in
 * the log next to the verdict it overrode — which is the difference between an
 * auditable decision and the click this replaces.
 */

/** What the log says about a run, read back from JSON rather than assumed. */
interface Judgement {
  verdict: string;
  reason: string;
  missing: string[];
  seq: number;
}

export interface AcceptOutcome {
  ok: boolean;
  message: string;
}

export function acceptTask(store: FleetStore, missionId: string, taskId: string, override?: string): AcceptOutcome {
  const task = store.tasks.get(taskId);
  if (!task.ok) return { ok: false, message: task.message };
  if (!task.value) return { ok: false, message: `There is no task ${taskId} to accept.` };
  if (task.value.status !== 'reported') {
    return { ok: false, message: `A task that is ${task.value.status} has not reported anything to accept.` };
  }

  // Two exact questions, asked of the database rather than of a page of log
  // scanned in memory. Each is one indexed walk backwards from the newest, so
  // neither can fall outside a window as the task's history grows.
  const reported = store.events.latestForTask(taskId, 'task_reported', 4);
  // Returned, not swallowed. An unreadable log is not evidence that nothing
  // judged this task, and saying so would put a false sentence — "nothing has
  // judged this task yet" — into the `overrode` field of the record this
  // command exists to produce.
  if (!reported.ok) return { ok: false, message: reported.message };
  const run = currentRunId(store, taskId, reported.value);
  const verdicts = store.events.latestForTask(taskId, 'task_judged', 8, run);
  if (!verdicts.ok) return { ok: false, message: verdicts.message };
  const judged = latestJudgement(verdicts.value);
  const reason = (override ?? '').trim();
  const blocker = judged === undefined ? 'nothing has judged this task yet' : refusalFor(judged);

  if (blocker !== undefined) {
    // An override with no reason is not an override. The point of the reason
    // is that somebody who reads the log later can tell what was known and
    // decided anyway, and "" tells them nothing.
    if (reason === '') {
      return {
        ok: false,
        message: `${capitalise(blocker)}. Accept anyway only with a reason, which is recorded beside the verdict.`,
      };
    }
  }

  const moved = store.tasks.setStatus(taskId, 'accepted');
  if (!moved.ok) return { ok: false, message: moved.message };

  // Written after the move, like `resolve_escalation`: an event claiming an
  // acceptance that then failed to happen is worse than a move nobody logged,
  // and `append` refuses to run inside a transaction it did not open, so the
  // two cannot be made atomic here.
  const logged = store.events.append({
    missionId,
    taskId,
    ...(run !== undefined ? { runId: run } : {}),
    actor: 'human',
    kind: 'task_accepted',
    payload: {
      verdict: judged?.verdict ?? null,
      reason: judged?.reason ?? null,
      missing: judged?.missing ?? [],
      // `overrode` is present only when one was needed, so the log
      // distinguishes "the evidence was good" from "it was not, and here is
      // who said so anyway".
      ...(blocker !== undefined ? { overrode: blocker } : {}),
      // The note is kept whenever somebody wrote one, INCLUDING when it turned
      // out not to be needed. The board decides whether to ask for a reason
      // from the judgement it is holding, and it holds only the last 200
      // events of a mission — so on a long mission it asks for one against
      // evidence the server can still see and the browser has dropped. Pinning
      // the note to the blocker threw that reason away and recorded the
      // acceptance as if nobody had hesitated.
      ...(reason !== '' ? { note: reason } : {}),
    },
    // Keyed by the task, which is sound because `accepted` is terminal in the
    // transition table: a task is accepted at most once, so there is no second
    // decision for this key to swallow.
    idempotencyKey: `accepted:${encodeURIComponent(taskId)}`,
  });
  if (!logged.ok) return { ok: false, message: logged.message };

  return {
    ok: true,
    message: blocker === undefined ? 'Accepted.' : `Accepted over ${blocker}.`,
  };
}

/**
 * Why this judgement does not support an acceptance, or `undefined` if it does.
 *
 * `needs_human` is NOT a blocker on its own — it is the answer a green run
 * gets, because `autoAcceptWhenGreen` is off and the plan wants an auditable
 * decision. What blocks is a rejection, or evidence with holes in it.
 */
function refusalFor(judged: Judgement): string | undefined {
  if (judged.verdict === 'reject') return `the evidence was rejected: ${judged.reason}`;
  if (judged.missing.length > 0) return `the evidence is incomplete: no ${judged.missing.join(', no ')}`;
  return undefined;
}

/**
 * The verdict on the attempt that is actually on the table.
 *
 * Two narrowings, and both of them are the difference between a check and a
 * rubber stamp.
 *
 * Scoped by RUN before it reaches here: the store is asked for `task_judged`
 * events of one run, so nothing in this loop can pick another attempt's
 * verdict. Which run that is comes from `currentRunFor` in `shared`, the one
 * definition of it, so this and the board cannot answer it differently on any
 * log that names one.
 *
 * A judgement describes the worktree of the run that produced it. A task that was sent back to `ready` and ran again has an old verdict
 * about a tree that no longer exists — and the case that matters is the second
 * attempt reporting BEFORE the pulse judges it, where taking the newest
 * verdict by sequence hands back attempt 1's `accept` and waves attempt 2
 * through without anything having looked at it. Unjudged has to read as
 * unjudged, which is what an override exists for.
 *
 * From the newest end of the TASK's log. Two window bugs, in sequence. The
 * first read the MISSION's log through `sinceForMission`, which is
 * `seq > 0 ORDER BY seq LIMIT 500` — the oldest 500 — so on any long mission
 * the verdict made seconds ago was outside it. Narrowing to the task looked
 * like the fix, on the reasoning that a task's log is bounded by its attempts.
 * It is not: a stuck run escalates once a minute, because the reason text
 * carries the elapsed minutes and the keyed note stops deduplicating. So the
 * same trap sat one level down, and only `tailForTask` — newest first — is
 * actually bounded by recency rather than by a hope about volume.
 */
function latestJudgement(events: readonly FleetEvent[]): Judgement | undefined {
  let latest: Judgement | undefined;
  // Newest first from the store, so the first that parses is the answer. A
  // malformed payload leaves the previous good one standing rather than
  // reading as "nothing judged this", which would demand an override.
  for (const event of events) {
    const read = readJudgement(event.payload, event.seq);
    if (read && (latest === undefined || read.seq > latest.seq)) latest = read;
  }
  return latest;
}

/**
 * The attempt on the table, and what to do when the log will not say.
 *
 * `currentRunFor` answers from the newest `task_reported`. When no such note is
 * in reach — a log written before runs were denormalised onto events, a task
 * moved to `reported` by hand — this falls back to the highest attempt, and
 * the board deliberately does NOT: it goes on showing the newest verdict so a
 * human can still read the evidence.
 *
 * That is the one place the two are allowed to differ, and the asymmetry is
 * the point. The board chooses wording; this decides. Failing closed here
 * keeps the property that matters — a second attempt is never accepted on the
 * first one's verdict — and the cost is that on such a log the board can offer
 * an accept this refuses, with a message saying why. A refused click is worth
 * more than a silent acceptance of the wrong tree.
 *
 * The runs read is a second read, outside the event snapshot above. It is
 * reached only on this fallback, where there is no snapshot answer to be
 * consistent with.
 */
function currentRunId(store: FleetStore, taskId: string, events: readonly FleetEvent[]): string | undefined {
  const reported = currentRunFor(events);
  if (reported !== undefined) return reported;
  const runs = store.runs.listByTask(taskId);
  if (!runs.ok || runs.value.length === 0) return undefined;
  return runs.value[runs.value.length - 1]?.id;
}

/** The payload is JSON the log never reaches into, so nothing here is assumed. */
function readJudgement(payload: unknown, seq: number): Judgement | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const verdict = record['verdict'];
  if (typeof verdict !== 'string') return undefined;
  return {
    verdict,
    reason: typeof record['reason'] === 'string' ? record['reason'] : '',
    missing: Array.isArray(record['missing']) ? record['missing'].filter((m): m is string => typeof m === 'string') : [],
    seq,
  };
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
