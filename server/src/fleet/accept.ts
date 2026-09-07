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

  const run = currentRunId(store, taskId);
  const judged = latestJudgement(store, taskId, run);
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
 * By RUN, because a judgement describes the worktree of the run that produced
 * it. A task that was sent back to `ready` and ran again has an old verdict
 * about a tree that no longer exists — and the case that matters is the second
 * attempt reporting BEFORE the pulse judges it, where taking the newest
 * verdict by sequence hands back attempt 1's `accept` and waves attempt 2
 * through without anything having looked at it. Unjudged has to read as
 * unjudged, which is what an override exists for.
 *
 * From the TASK's log, not the mission's. `sinceForMission(id)` is
 * `seq > 0 ORDER BY seq LIMIT 500` — the OLDEST 500 events of the mission. So
 * on any mission long enough to matter, the judgement made seconds ago was not
 * in the window and acceptance demanded an override forever, which trains the
 * one habit this whole command exists to prevent. A task's own log is bounded
 * by its attempts, so the same read is sound here.
 */
function latestJudgement(store: FleetStore, taskId: string, run: string | undefined): Judgement | undefined {
  const events = store.events.sinceForTask(taskId);
  if (!events.ok) return undefined;
  let latest: Judgement | undefined;
  for (const event of events.value) {
    if (event.kind !== 'task_judged') continue;
    // A judgement that does not say which run it describes cannot be shown to
    // describe this one. Refusing it costs a reason; accepting it would spend
    // the evidence of one attempt on another.
    if (run !== undefined && event.runId !== run) continue;
    const read = readJudgement(event.payload, event.seq);
    if (read && (latest === undefined || read.seq > latest.seq)) latest = read;
  }
  return latest;
}

/**
 * The attempt whose report is on the table.
 *
 * The run named by the newest `task_reported`, because that note is written in
 * exactly one place: the branch of `applyTaskIntent` that moves a task INTO
 * `reported`. So it names the claim that put the task in the state this
 * command is being asked to act on, which is the definition of the attempt
 * under review.
 *
 * It is not "the highest attempt", which is what this used to say. Runs of one
 * task can overlap and can finish out of order — a second attempt dispatched
 * while the first was stuck can report first, hit the `stillHeld` branch, and
 * never move the task at all. Reading the highest attempt there answered with
 * a run whose claim nobody is looking at, and the board, reading the log,
 * answered with the one they are. The two have to agree or the panel offers a
 * decision this refuses, and `web/src/judged.ts` derives it the same way from
 * the same events.
 *
 * Falls back to the highest attempt when no such note exists: a task moved to
 * `reported` by hand or by a test has a claim on the table that the log does
 * not describe, and refusing every acceptance there would be worse than
 * scoping to the newest run.
 */
function currentRunId(store: FleetStore, taskId: string): string | undefined {
  const events = store.events.sinceForTask(taskId);
  if (events.ok) {
    let reported: string | undefined;
    for (const event of events.value) {
      if (event.kind === 'task_reported' && event.runId !== undefined) reported = event.runId;
    }
    if (reported !== undefined) return reported;
  }
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
