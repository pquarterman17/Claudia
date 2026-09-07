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

  it('refuses when no attempt is recorded as the one under review', () => {
    // There is no fallback any more. A task moved to `reported` with no run
    // having claimed it — a later attempt still running, or a record from
    // before the column — has no attempt under review, and reading any
    // attempt's verdict there authorised a tree nobody had judged.
    const mission = store.missions.create({ name: 'm3', body: '', cwd: '/repo' });
    if (!mission.ok) throw new Error(mission.message);
    const task = store.tasks.create({ missionId: mission.value.id, title: 't', description: '', cwd: '/repo' });
    if (!task.ok) throw new Error(task.message);
    const judged = store.events.append({
      missionId: mission.value.id,
      taskId: task.value.id,
      runId: 'some-run',
      actor: 'system',
      kind: 'task_judged',
      payload: { verdict: 'needs_human', reason: 'green', missing: [] },
      idempotencyKey: 'judged:some-run',
    });
    if (!judged.ok) throw new Error(judged.message);
    for (const status of ['ready', 'running', 'reported'] as const) {
      const moved = store.tasks.setStatus(task.value.id, status);
      if (!moved.ok) throw new Error(moved.message);
    }

    const outcome = acceptTask(store, mission.value.id, task.value.id);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/[Nn]o attempt is recorded/);
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

  it('never discards a completion claim to pay for a retry', () => {
    // The regression this replaces. "Keep the later" turned a sibling run's
    // retry into the winner over a claim already in hand: the task was routed
    // `running -> failed -> ready`, a fresh child was reserved and paid for,
    // `result.reported` never moved, and the human never saw the report.
    // Ranked by cost instead — a retry spends, a claim does not — so the
    // answer no longer depends on which run happened to be walked first.
    const reported = { to: 'reported' as const, reason: 'the child finished', runId: 'r1' };
    const retry = { to: 'ready' as const, reason: 'orphaned', attempt: 2, key: 'k', runId: 'r2' };
    expect(worseOf(reported, retry)).toBe(reported);
    expect(worseOf(retry, reported)).toBe(reported);
  });

  it('names the later attempt when two intents cost the same', () => {
    // Observations are walked in started-at order and attempts are sequential,
    // so the last intent of a given rank is the highest attempt. Keeping the
    // first meant the note named attempt 1 while acceptance judged attempt 2.
    const first = { to: 'reported' as const, reason: 'attempt 1 finished', runId: 'r1' };
    const second = { to: 'reported' as const, reason: 'attempt 2 finished', runId: 'r2' };
    expect(worseOf(first, second).runId).toBe('r2');
    expect(worseOf(undefined, first).runId).toBe('r1');
  });

  it('keeps distinct keys for two runs without letting an id fake the join', () => {
    // `escalationKey` encodes because a raw join collides. Building its first
    // argument by concatenating ids with colons handed that class back, and a
    // collision here is silent: the losing note is swallowed as a duplicate.
    const mission = store.missions.create({ name: 'm4', body: '', cwd: '/repo' });
    if (!mission.ok) throw new Error(mission.message);
    const task = store.tasks.create({ missionId: mission.value.id, id: 'plain', title: 't', description: '', cwd: '/repo' });
    const sneaky = store.tasks.create({ missionId: mission.value.id, id: 'plain:r1', title: 't', description: '', cwd: '/repo' });
    if (!task.ok || !sneaky.ok) throw new Error('could not create tasks');

    note(store, mission.value.id, task.value.id, 'task_reported', 'done', 'r1');
    note(store, mission.value.id, sneaky.value.id, 'task_reported', 'done', undefined);

    const one = store.events.sinceForTask(task.value.id);
    const two = store.events.sinceForTask(sneaky.value.id);
    if (!one.ok || !two.ok) throw new Error('could not read the log');
    expect(one.value).toHaveLength(1);
    expect(two.value).toHaveLength(1);
  });
});

describe('asking the log an exact question', () => {
  it('answers about one run without reading the rest of the task', () => {
    const mission = store.missions.create({ name: 'm7', body: '', cwd: '/repo' });
    if (!mission.ok) throw new Error(mission.message);
    const task = store.tasks.create({ missionId: mission.value.id, title: 't', description: '', cwd: '/repo' });
    if (!task.ok) throw new Error(task.message);
    for (const run of ['r1', 'r2']) {
      const judged = store.events.append({
        missionId: mission.value.id,
        taskId: task.value.id,
        runId: run,
        actor: 'system',
        kind: 'task_judged',
        payload: { verdict: 'needs_human', reason: `${run} checked`, missing: [] },
        idempotencyKey: `judged:${run}`,
      });
      if (!judged.ok) throw new Error(judged.message);
    }

    const one = store.events.latestForTask(task.value.id, 'task_judged', 8, 'r1');
    if (!one.ok) throw new Error(one.message);
    expect(one.value.map((event) => event.runId)).toEqual(['r1']);

    const missing = store.events.latestForTask(task.value.id, 'task_judged', 8, 'r3');
    if (!missing.ok) throw new Error(missing.message);
    expect(missing.value).toHaveLength(0);

    // Newest first, so the first that parses is the answer.
    const both = store.events.latestForTask(task.value.id, 'task_judged', 8);
    if (!both.ok) throw new Error(both.message);
    expect(both.value.map((event) => event.runId)).toEqual(['r2', 'r1']);
  });
});

describe('a note that must not grow without bound', () => {
  it('keeps one line for a stuck run however long it stays stuck', () => {
    // The root cause under three separate window fixes. An escalation's reason
    // carries the elapsed minutes, so keying the note on it wrote a new row
    // every minute — about sixty an hour — and that is what pushed a task's
    // log past every page anything read it through. `watchdog-action.ts` keys
    // the escalation ROW on the tool for exactly this reason; the note now
    // takes the same stable key.
    const mission = store.missions.create({ name: 'm6', body: '', cwd: '/repo' });
    if (!mission.ok) throw new Error(mission.message);
    const task = store.tasks.create({ missionId: mission.value.id, title: 't', description: '', cwd: '/repo' });
    if (!task.ok) throw new Error(task.message);

    for (let minute = 1; minute <= 40; minute++) {
      note(
        store,
        mission.value.id,
        task.value.id,
        'escalated',
        `waiting ${minute}m for approval of Bash: the child has not moved`,
        'r1',
        'escalation:r1:Bash',
      );
    }
    const events = store.events.sinceForTask(task.value.id);
    if (!events.ok) throw new Error(events.message);
    expect(events.value).toHaveLength(1);
    // The message still says what it said the first time it was written.
    expect((events.value[0]?.payload as { reason: string }).reason).toMatch(/waiting 1m/);
  });
});
