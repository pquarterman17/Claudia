import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startFleet } from '../src/fleet/boot.js';
import { acceptTask } from '../src/fleet/accept.js';
import { handleFleetCommand } from '../src/fleet/commands.js';
import type { FleetStore } from '../src/store/index.js';

/**
 * Acceptance, against the evidence rather than because somebody clicked.
 *
 * `reported -> accepted` was a plain status move: the transition table allowed
 * it, the board offered it, the store wrote it, and nothing on that path ever
 * read the judgement the pulse had just made. A task whose checks failed,
 * whose diff was empty, or which had never been judged at all could be
 * accepted with one click — which is the completion contract undone at the
 * last step, since `reported` and `accepted` are separate states precisely
 * because a claim has to be checked by something.
 */

const dir = mkdtempSync(join(tmpdir(), 'claudia-accept-'));
const opened: FleetStore[] = [];
afterAll(() => {
  for (const store of opened) store.close();
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
/** A mission with one task that has reported, and whatever verdict was given. */
function fixture(judgements: Array<Record<string, unknown>> = []) {
  const boot = startFleet(new Set(), join(dir, `db-${counter++}`, 'fleet.db'));
  if (!boot.store) throw new Error(boot.summary);
  const store = boot.store;
  opened.push(store);

  const mission = store.missions.create({ name: 'm', body: '', cwd: '/repo' });
  if (!mission.ok) throw new Error(mission.message);
  const task = store.tasks.create({ missionId: mission.value.id, title: 't', description: '', cwd: '/repo' });
  if (!task.ok) throw new Error(task.message);
  for (const status of ['ready', 'running', 'reported'] as const) {
    const moved = store.tasks.setStatus(task.value.id, status);
    if (!moved.ok) throw new Error(moved.message);
  }
  judgements.forEach((payload, index) => {
    const appended = store.events.append({
      missionId: mission.value.id,
      taskId: task.value.id,
      actor: 'system',
      kind: 'task_judged',
      payload,
      idempotencyKey: `judged:${index}`,
    });
    if (!appended.ok) throw new Error(appended.message);
  });
  return { store, missionId: mission.value.id, taskId: task.value.id };
}

const GREEN = { verdict: 'needs_human', reason: 'every check passed; acceptance is yours to give', missing: [] };
const HOLES = { verdict: 'needs_human', reason: 'no test results', missing: ['test results'] };
const BAD = { verdict: 'reject', reason: '1 failing check: npm test', missing: [] };

function statusOf(store: FleetStore, taskId: string): string {
  const read = store.tasks.get(taskId);
  if (!read.ok) throw new Error(read.message);
  return read.value?.status ?? 'gone';
}

function accepted(store: FleetStore, missionId: string): Record<string, unknown> | undefined {
  const log = store.events.sinceForMission(missionId);
  if (!log.ok) throw new Error(log.message);
  return log.value.find((e) => e.kind === 'task_accepted')?.payload as Record<string, unknown> | undefined;
}

describe('accepting what the evidence supports', () => {
  it('accepts a run that was judged clean, and records the verdict it was made on', () => {
    const { store, missionId, taskId } = fixture([GREEN]);
    const outcome = acceptTask(store, missionId, taskId);
    expect(outcome.ok, outcome.message).toBe(true);
    expect(statusOf(store, taskId)).toBe('accepted');

    // The record is the point: an acceptance nobody can audit is the click
    // this replaces, with a state name attached.
    const payload = accepted(store, missionId);
    expect(payload?.['verdict']).toBe('needs_human');
    expect(payload?.['missing']).toEqual([]);
    expect(payload?.['overrode']).toBeUndefined();
  });

  it('takes the latest verdict, not the first', () => {
    // A task sent back to `ready` runs again, and the older judgement
    // describes a different run's worktree.
    const { store, missionId, taskId } = fixture([BAD, GREEN]);
    expect(acceptTask(store, missionId, taskId).ok).toBe(true);
  });
});

describe('refusing what it does not', () => {
  it('refuses a task nothing has judged', () => {
    const { store, missionId, taskId } = fixture();
    const outcome = acceptTask(store, missionId, taskId);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/nothing has judged/i);
    expect(statusOf(store, taskId)).toBe('reported');
  });

  it('refuses a rejection, and says which one', () => {
    const { store, missionId, taskId } = fixture([BAD]);
    const outcome = acceptTask(store, missionId, taskId);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/1 failing check/);
    expect(statusOf(store, taskId)).toBe('reported');
  });

  it('refuses evidence with holes in it', () => {
    const { store, missionId, taskId } = fixture([HOLES]);
    const outcome = acceptTask(store, missionId, taskId);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/no test results/);
  });

  it('refuses a task that has not reported', () => {
    const { store, missionId, taskId } = fixture([GREEN]);
    const first = acceptTask(store, missionId, taskId);
    expect(first.ok).toBe(true);
    // Twice is not idempotent here, and should not be: the second caller is
    // asking to accept something that is no longer a claim.
    const again = acceptTask(store, missionId, taskId);
    expect(again.ok).toBe(false);
    expect(again.message).toMatch(/accepted has not reported/);
  });
});

describe('overriding it, which has to be possible', () => {
  // A verify command that is wrong rejects good work, and judging happens once
  // per run — nothing re-judges a task whose command has since been fixed. So
  // without this, that task could never be accepted at all.
  it('accepts over a rejection when a reason is given, and records both', () => {
    const { store, missionId, taskId } = fixture([BAD]);
    const outcome = acceptTask(store, missionId, taskId, 'the check itself is broken, fixed in #71');
    expect(outcome.ok, outcome.message).toBe(true);
    expect(statusOf(store, taskId)).toBe('accepted');

    const payload = accepted(store, missionId);
    expect(payload?.['verdict']).toBe('reject');
    expect(payload?.['overrode']).toMatch(/1 failing check/);
    expect(payload?.['note']).toMatch(/fixed in #71/);
  });

  it('refuses an override with no reason in it', () => {
    // The reason is the whole difference between an auditable decision and a
    // click, so a blank one is not an override.
    const { store, missionId, taskId } = fixture([BAD]);
    expect(acceptTask(store, missionId, taskId, '   ').ok).toBe(false);
    expect(statusOf(store, taskId)).toBe('reported');
  });

  it('accepts over never having been judged at all', () => {
    const { store, missionId, taskId } = fixture();
    const outcome = acceptTask(store, missionId, taskId, 'checked it by hand');
    expect(outcome.ok, outcome.message).toBe(true);
    expect(accepted(store, missionId)?.['overrode']).toMatch(/nothing has judged/);
  });
});

describe('over the wire', () => {
  it('will not accept through a status change any more', () => {
    // The hole itself. The transition is legal and the store would write it,
    // so the refusal has to be at the boundary the board talks to.
    const { store, missionId, taskId } = fixture([BAD]);
    const events = handleFleetCommand({ type: 'set_task_status', missionId, taskId, status: 'accepted' }, store);
    const notice = events.find((e) => e.type === 'notice');
    expect(notice && 'message' in notice ? notice.message : '').toMatch(/accept_task/);
    expect(statusOf(store, taskId)).toBe('reported');
  });

  it('answers the accept command with the task list and what it did', () => {
    const { store, missionId, taskId } = fixture([GREEN]);
    const events = handleFleetCommand({ type: 'accept_task', missionId, taskId }, store);
    expect(events.some((e) => e.type === 'tasks')).toBe(true);
    expect(statusOf(store, taskId)).toBe('accepted');
  });

  it('reports a refusal rather than silently doing nothing', () => {
    const { store, missionId, taskId } = fixture([HOLES]);
    const events = handleFleetCommand({ type: 'accept_task', missionId, taskId }, store);
    const notice = events.find((e) => e.type === 'notice');
    expect(notice && 'message' in notice ? notice.message : '').toMatch(/no test results/);
    expect(statusOf(store, taskId)).toBe('reported');
  });
});

/**
 * A judgement describes the worktree of the run that made it, and nothing else.
 *
 * The verdict was found by task alone, so the newest one stood in for every
 * attempt. The case that bites is the ordinary one: a task is sent back, runs
 * again, and reports — and for the seconds before the pulse judges it, the
 * board offered a plain `accept` backed by attempt 1's verdict, attempt 1's
 * branch and attempt 1's tests. Nothing had looked at the work being accepted.
 */
function attemptOf(store: FleetStore, missionId: string, taskId: string): string {
  const created = store.runs.create({ missionId, taskId, agent: 'claude' });
  if (!created.ok) throw new Error(created.message);
  return created.value.id;
}

function judged(store: FleetStore, missionId: string, taskId: string, runId: string, payload: Record<string, unknown>) {
  const appended = store.events.append({
    missionId,
    taskId,
    runId,
    actor: 'system',
    kind: 'task_judged',
    payload,
    idempotencyKey: `judged:${runId}`,
  });
  if (!appended.ok) throw new Error(appended.message);
}

describe('the attempt on the table', () => {
  it('will not spend the first attempt\'s verdict on an unjudged second one', () => {
    const { store, missionId, taskId } = fixture();
    judged(store, missionId, taskId, attemptOf(store, missionId, taskId), GREEN);
    // Sent back, ran again, reported. The pulse has not judged this one yet.
    attemptOf(store, missionId, taskId);

    const outcome = acceptTask(store, missionId, taskId);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/[Nn]othing has judged/);
    expect(statusOf(store, taskId)).toBe('reported');
  });

  it('accepts on the current attempt, over a rejection of the one before it', () => {
    const { store, missionId, taskId } = fixture();
    judged(store, missionId, taskId, attemptOf(store, missionId, taskId), BAD);
    judged(store, missionId, taskId, attemptOf(store, missionId, taskId), GREEN);

    const outcome = acceptTask(store, missionId, taskId);
    expect(outcome.ok, outcome.message).toBe(true);
    // On the current verdict, and recorded as needing no override.
    expect(accepted(store, missionId)?.['verdict']).toBe('needs_human');
    expect(accepted(store, missionId)?.['overrode']).toBeUndefined();
  });

  it('names the run it accepted, so the log says which tree was signed off', () => {
    const { store, missionId, taskId } = fixture();
    const run = attemptOf(store, missionId, taskId);
    judged(store, missionId, taskId, run, GREEN);
    expect(acceptTask(store, missionId, taskId).ok).toBe(true);

    const log = store.events.sinceForMission(missionId);
    if (!log.ok) throw new Error(log.message);
    expect(log.value.find((e) => e.kind === 'task_accepted')?.runId).toBe(run);
  });

  it('finds a verdict on a mission with more history than one read returns', () => {
    // `sinceForMission(id)` is the OLDEST 500 events of a mission. Reading the
    // verdict through it meant that on any mission long enough to matter, the
    // judgement made seconds ago was outside the window and acceptance asked
    // for an override forever — training the one habit this command exists to
    // prevent.
    const { store, missionId, taskId } = fixture();
    for (let i = 0; i < 520; i++) {
      const filler = store.events.append({ missionId, actor: 'system', kind: 'notice', payload: { i } });
      if (!filler.ok) throw new Error(filler.message);
    }
    judged(store, missionId, taskId, attemptOf(store, missionId, taskId), GREEN);

    const outcome = acceptTask(store, missionId, taskId);
    expect(outcome.ok, outcome.message).toBe(true);
    expect(outcome.message).toBe('Accepted.');
  });

  it('keeps a reason somebody wrote even when the evidence turned out to hold', () => {
    // The board asks for a reason from the judgement IT holds, and it holds
    // only the tail of a mission's log. So a human can write one against
    // evidence the server can still see — and pinning the note to the blocker
    // threw that reason away and recorded the acceptance as unhesitating.
    const { store, missionId, taskId } = fixture();
    judged(store, missionId, taskId, attemptOf(store, missionId, taskId), GREEN);

    expect(acceptTask(store, missionId, taskId, 'accepting on the strength of the PR').ok).toBe(true);
    const payload = accepted(store, missionId);
    expect(payload?.['note']).toBe('accepting on the strength of the PR');
    expect(payload?.['overrode']).toBeUndefined();
  });
});
