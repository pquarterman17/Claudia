import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startFleet } from '../src/fleet/boot.js';
import { note } from '../src/fleet/pulse-report.js';
import { acceptTask } from '../src/fleet/accept.js';
import { worseOf } from '../src/fleet/pulse-apply.js';

const dir = mkdtempSync(join(tmpdir(), 'claudia-pulse-report-'));
const boot = startFleet(new Set(), join(dir, 'fleet.db'));
if (!boot.store) throw new Error(boot.summary);
const store = boot.store;
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('attempt-scoped completion notes', () => {
  it('records the same completion reason again for a later run', () => {
    const mission = store.missions.create({ name: 'm', body: '', cwd: '/repo' });
    if (!mission.ok) throw new Error(mission.message);
    const task = store.tasks.create({ missionId: mission.value.id, title: 't', description: '', cwd: '/repo' });
    if (!task.ok) throw new Error(task.message);
    const first = store.runs.create({ missionId: mission.value.id, taskId: task.value.id, agent: 'claude', state: 'dispatched' });
    const second = store.runs.create({ missionId: mission.value.id, taskId: task.value.id, agent: 'claude', state: 'dispatched' });
    if (!first.ok || !second.ok) throw new Error('could not create runs');
    note(store, mission.value.id, task.value.id, 'task_reported', 'the child ended its turn', first.value.id);
    note(store, mission.value.id, task.value.id, 'task_reported', 'the child ended its turn', second.value.id);
    const events = store.events.sinceForTask(task.value.id);
    if (!events.ok) throw new Error(events.message);
    expect(events.value.map((event) => event.runId)).toEqual([first.value.id, second.value.id]);
  });
});

/**
 * Every note a run produces names the run.
 *
 * The board reads run identity off these notes to tell which attempt a verdict
 * describes. `task_reported` alone was not enough: `applyTaskIntent` returns
 * before writing it when another run still holds the task, and again when the
 * task's route is refused — and those are exactly the branches a second
 * attempt takes, so the marker went missing in the overlapping-attempt case it
 * existed for.
 */
describe('run identity on the notes a pulse writes', () => {
  it('names the run on a note written when the task did not move', () => {
    const mission = store.missions.create({ name: 'm2', body: '', cwd: '/repo' });
    if (!mission.ok) throw new Error(mission.message);
    const task = store.tasks.create({ missionId: mission.value.id, title: 't', description: '', cwd: '/repo' });
    if (!task.ok) throw new Error(task.message);
    const run = store.runs.create({ missionId: mission.value.id, taskId: task.value.id, agent: 'claude', state: 'dispatched' });
    if (!run.ok) throw new Error(run.message);

    for (const kind of ['run_ended_task_held', 'task_left_as_is', 'task_given_up'] as const) {
      note(store, mission.value.id, task.value.id, kind, `${kind} happened`, run.value.id);
    }
    const events = store.events.sinceForTask(task.value.id);
    if (!events.ok) throw new Error(events.message);
    expect(events.value.map((event) => event.runId)).toEqual([run.value.id, run.value.id, run.value.id]);
  });

  it('agrees with acceptance about which attempt is current', () => {
    // `worseOf` kept the FIRST intent of equal severity, so with two runs
    // reporting in one pulse the note named attempt 1 while `acceptTask` read
    // attempt 2 — the board and the server scoping to different verdicts for
    // the same click. Observations are walked in started-at order, so keeping
    // the later intent makes the note name the highest attempt, which is the
    // one `listByTask` hands acceptance.
    const mission = store.missions.create({ name: 'm3', body: '', cwd: '/repo' });
    if (!mission.ok) throw new Error(mission.message);
    const task = store.tasks.create({ missionId: mission.value.id, title: 't', description: '', cwd: '/repo' });
    if (!task.ok) throw new Error(task.message);
    const first = store.runs.create({ missionId: mission.value.id, taskId: task.value.id, agent: 'claude' });
    const second = store.runs.create({ missionId: mission.value.id, taskId: task.value.id, agent: 'claude' });
    if (!first.ok || !second.ok) throw new Error('could not create runs');

    // Attempt 2 is judged; attempt 1 is not. Acceptance must read attempt 2.
    const judged = store.events.append({
      missionId: mission.value.id,
      taskId: task.value.id,
      runId: second.value.id,
      actor: 'system',
      kind: 'task_judged',
      payload: { verdict: 'reject', reason: 'the checks failed', missing: [] },
      idempotencyKey: `judged:${second.value.id}`,
    });
    if (!judged.ok) throw new Error(judged.message);
    for (const status of ['ready', 'running', 'reported'] as const) {
      const moved = store.tasks.setStatus(task.value.id, status);
      if (!moved.ok) throw new Error(moved.message);
    }

    const outcome = acceptTask(store, mission.value.id, task.value.id);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/the checks failed/);
  });
});

describe('which of two runs a task defers to', () => {
  it('still gives up rather than believing a claim from its sibling', () => {
    // The bound on spending is the property worth keeping when two runs of one
    // task disagree, and it holds whichever order they are seen in.
    const failed = { to: 'failed' as const, reason: 'gave up', runId: 'r1' };
    const reported = { to: 'reported' as const, reason: 'finished', runId: 'r2' };
    expect(worseOf(failed, reported)).toBe(failed);
    expect(worseOf(reported, failed)).toBe(failed);
  });

  it('names the later attempt when neither is worse than the other', () => {
    // Observations are walked in started-at order and attempts are sequential,
    // so the last intent of a given severity is the highest attempt — the one
    // `acceptTask` calls current. Keeping the first meant the note named
    // attempt 1 while acceptance judged attempt 2.
    const first = { to: 'reported' as const, reason: 'attempt 1 finished', runId: 'r1' };
    const second = { to: 'reported' as const, reason: 'attempt 2 finished', runId: 'r2' };
    expect(worseOf(first, second).runId).toBe('r2');
    expect(worseOf(undefined, first).runId).toBe('r1');
  });
});
