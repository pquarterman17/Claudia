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

  const judged = latestJudgement(store, missionId, taskId);
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
    actor: 'human',
    kind: 'task_accepted',
    payload: {
      verdict: judged?.verdict ?? null,
      reason: judged?.reason ?? null,
      missing: judged?.missing ?? [],
      // Present only when one was needed, so the log distinguishes "the
      // evidence was good" from "it was not, and here is who said so anyway".
      ...(blocker !== undefined ? { overrode: blocker, note: reason } : {}),
    },
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
 * The most recent verdict for one task.
 *
 * By sequence, not by position: a task that was sent back to `ready` and ran
 * again has two judgements, and the older one describes a different run's
 * worktree.
 */
function latestJudgement(store: FleetStore, missionId: string, taskId: string): Judgement | undefined {
  const events = store.events.sinceForMission(missionId);
  if (!events.ok) return undefined;
  let latest: Judgement | undefined;
  for (const event of events.value) {
    if (event.kind !== 'task_judged' || event.taskId !== taskId) continue;
    const read = readJudgement(event.payload, event.seq);
    if (read && (latest === undefined || read.seq > latest.seq)) latest = read;
  }
  return latest;
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
