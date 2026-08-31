import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { transact, type StoreResult } from '../src/store/db.js';
import { openFleetStore, type FleetStore } from '../src/store/index.js';

const dir = mkdtempSync(join(tmpdir(), 'claudia-store-missions-'));

/**
 * Every store this file opens, closed before the directory is removed.
 *
 * Not defensive tidiness: on Windows an open handle makes `unlink` fail with
 * EBUSY, so one test forgetting to close fails the whole FILE during teardown
 * — with every test reported as passing, which is a confusing way to find out.
 * Linux unlinks open files happily, so this is invisible until CI runs.
 * Owning cleanup here means a new test cannot reintroduce it by omission.
 */
const opened: FleetStore[] = [];
afterAll(() => {
  for (const fleet of opened) fleet.close();
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
function store(name = `db-${counter++}`): FleetStore {
  const result = openFleetStore(join(dir, name, 'fleet.db'));
  if (!result.ok) throw new Error(result.message);
  opened.push(result.value);
  return result.value;
}

/** Unwraps a result in a test, where a failure is simply the test failing. */
function value<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

function seedMission(fleet: FleetStore, name = 'Ship persistence') {
  return value(fleet.missions.create({ name, body: 'Make a mission outlive the server.', cwd: '/repo' }));
}

describe('missions', () => {
  it('creates with the shared defaults and reads back', () => {
    const fleet = store();
    const mission = seedMission(fleet);
    expect(mission.status).toBe('active');
    // Paused by default: a mission that starts watching would dispatch work
    // before anyone had a chance to look at it.
    expect(mission.watch).toBe('paused');
    expect(mission.pulseSec).toBe(60);
    expect(mission.maxChildren).toBe(4);

    expect(value(fleet.missions.get(mission.id))).toEqual(mission);
    expect(value(fleet.missions.list())).toEqual([mission]);
    expect(value(fleet.missions.list('archived'))).toEqual([]);
    fleet.close();
  });

  it('refuses a pulse or child limit outside the shared bounds', () => {
    const fleet = store();
    const tooFast = fleet.missions.create({ name: 'a', body: 'b', cwd: '/repo', pulseSec: 5 });
    expect(tooFast.ok).toBe(false);
    if (!tooFast.ok) expect(tooFast.message).toMatch(/between 30 and 14400/);
    expect(fleet.missions.create({ name: 'a', body: 'b', cwd: '/repo', maxChildren: 99 }).ok).toBe(false);
    expect(value(fleet.missions.list())).toEqual([]);
    fleet.close();
  });

  it('moves watch state and reports an unknown id', () => {
    const fleet = store();
    const mission = seedMission(fleet);
    expect(value(fleet.missions.setWatch(mission.id, 'watching')).watch).toBe('watching');
    expect(value(fleet.missions.setStatus(mission.id, 'archived')).status).toBe('archived');
    const missing = fleet.missions.setWatch('nope', 'paused');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toContain('No mission with id nope');
    fleet.close();
  });

  it('round-trips optional budgets and leaves them absent when unset', () => {
    const path = 'budgets';
    const first = store(path);
    const budgeted = value(
      first.missions.create({ name: 'Budgeted', body: 'b', cwd: '/repo', budgetSec: 3600, budgetTokens: 2_000_000 }),
    );
    const open = seedMission(first, 'No ceiling');
    expect(open.budgetSec).toBeUndefined();
    first.close();

    const second = store(path);
    expect(value(second.missions.get(budgeted.id))?.budgetSec).toBe(3600);
    expect(value(second.missions.get(budgeted.id))?.budgetTokens).toBe(2_000_000);
    expect(value(second.missions.get(open.id))?.budgetTokens).toBeUndefined();
    second.close();
  });

  it('refuses a budget of zero, which is not the same as no budget', () => {
    const fleet = store();
    const zero = fleet.missions.create({ name: 'a', body: 'b', cwd: '/r', budgetSec: 0 });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.message).toMatch(/above zero/);
    expect(fleet.missions.create({ name: 'a', body: 'b', cwd: '/r', budgetTokens: 1.5 }).ok).toBe(false);
    fleet.close();
  });

  it('refuses a status move the contract does not allow', () => {
    const fleet = store();
    const mission = seedMission(fleet);
    value(fleet.missions.setStatus(mission.id, 'archived'));
    const refused = fleet.missions.setStatus(mission.id, 'completed');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toBe('A mission that is archived cannot become completed.');
    expect(value(fleet.missions.get(mission.id))?.status).toBe('archived');

    // Reopening a finished mission is legal on purpose: one more task belongs
    // to the same intention rather than to a second record of it.
    value(fleet.missions.setStatus(mission.id, 'active'));
    value(fleet.missions.setStatus(mission.id, 'completed'));
    expect(value(fleet.missions.setStatus(mission.id, 'active')).status).toBe('active');
    fleet.close();
  });

  it('returns undefined for a mission that was never there', () => {
    const fleet = store();
    expect(value(fleet.missions.get('ghost'))).toBeUndefined();
    fleet.close();
  });
});

describe('tasks', () => {
  it('round-trips dependsOn, empty and populated, across a restart', () => {
    const path = 'depends';
    const first = store(path);
    const mission = seedMission(first);
    const a = value(first.tasks.create({ missionId: mission.id, title: 'A', description: '', cwd: '/repo' }));
    const b = value(
      first.tasks.create({
        missionId: mission.id,
        title: 'B',
        description: '',
        cwd: '/repo',
        dependsOn: [a.id, 'other-task'],
        acceptance: 'tests pass',
      }),
    );
    expect(a.dependsOn).toEqual([]);
    first.close();

    const second = store(path);
    const reloaded = value(second.tasks.listByMission(mission.id));
    expect(reloaded.map((task) => task.id)).toEqual([a.id, b.id]);
    expect(reloaded[1]?.dependsOn).toEqual([a.id, 'other-task']);
    expect(reloaded[0]?.dependsOn).toEqual([]);
    expect(reloaded[1]?.acceptance).toBe('tests pass');
    second.close();
  });

  it('lists by mission in dispatch order', () => {
    const fleet = store();
    const mission = seedMission(fleet);
    const low = value(fleet.tasks.create({ missionId: mission.id, title: 'later', description: '', cwd: '/r', priority: 5 }));
    const high = value(fleet.tasks.create({ missionId: mission.id, title: 'first', description: '', cwd: '/r', priority: 1 }));
    expect(value(fleet.tasks.listByMission(mission.id)).map((task) => task.id)).toEqual([high.id, low.id]);
    fleet.close();
  });

  it('refuses an illegal status move and keeps the old status', () => {
    const fleet = store();
    const mission = seedMission(fleet);
    const task = value(fleet.tasks.create({ missionId: mission.id, title: 'A', description: '', cwd: '/r' }));

    // proposed -> running is not in TASK_TRANSITIONS: a task is made ready and
    // dispatched, never dispatched straight off the proposal.
    const refused = fleet.tasks.setStatus(task.id, 'running');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toBe('A task that is proposed cannot become running.');
    expect(value(fleet.tasks.get(task.id))?.status).toBe('proposed');

    expect(value(fleet.tasks.setStatus(task.id, 'ready')).status).toBe('ready');
    expect(value(fleet.tasks.setStatus(task.id, 'running')).status).toBe('running');
    // Accepted is terminal, so nothing leaves it.
    value(fleet.tasks.setStatus(task.id, 'reported'));
    value(fleet.tasks.setStatus(task.id, 'accepted'));
    expect(fleet.tasks.setStatus(task.id, 'ready').ok).toBe(false);
    fleet.close();
  });

  it('treats setting the status a task already has as a no-op', () => {
    const fleet = store();
    const mission = seedMission(fleet);
    const task = value(fleet.tasks.create({ missionId: mission.id, title: 'A', description: '', cwd: '/r' }));
    // A replayed event must be able to arrive at the same state twice.
    expect(value(fleet.tasks.setStatus(task.id, 'proposed'))).toEqual(task);
    fleet.close();
  });

  it('refuses a task whose mission does not exist', () => {
    const fleet = store();
    const orphan = fleet.tasks.create({ missionId: 'no-such-mission', title: 'A', description: '', cwd: '/r' });
    expect(orphan.ok).toBe(false);
    if (!orphan.ok) expect(orphan.message).toMatch(/FOREIGN KEY/i);
    fleet.close();
  });

  it('takes its tasks with it when a mission is deleted', () => {
    const fleet = store();
    const mission = seedMission(fleet);
    value(fleet.tasks.create({ missionId: mission.id, title: 'A', description: '', cwd: '/r' }));
    fleet.db.prepare('DELETE FROM missions WHERE id = ?').run(mission.id);
    expect(value(fleet.tasks.listByMission(mission.id))).toEqual([]);
    fleet.close();
  });
});

describe('child runs', () => {
  it('numbers attempts per task and refuses a repeated one', () => {
    const fleet = store();
    const mission = seedMission(fleet);
    const task = value(fleet.tasks.create({ missionId: mission.id, title: 'A', description: '', cwd: '/r' }));

    const first = value(fleet.runs.create({ missionId: mission.id, taskId: task.id, agent: 'claude' }));
    const second = value(fleet.runs.create({ missionId: mission.id, taskId: task.id, agent: 'codex' }));
    expect([first.attempt, second.attempt]).toEqual([1, 2]);

    // A repeated dispatch of the same attempt is the shape a duplicated pulse
    // takes, and the unique index is the last thing standing in its way.
    const duplicate = fleet.runs.create({ missionId: mission.id, taskId: task.id, agent: 'claude', attempt: 1 });
    expect(duplicate.ok).toBe(false);
    expect(value(fleet.runs.listByTask(task.id))).toHaveLength(2);
    fleet.close();
  });

  it('moves through legal states and stamps the end', () => {
    const fleet = store();
    const mission = seedMission(fleet);
    const task = value(fleet.tasks.create({ missionId: mission.id, title: 'A', description: '', cwd: '/r' }));
    const run = value(fleet.runs.create({ missionId: mission.id, taskId: task.id, agent: 'claude', sessionId: 's1' }));
    expect(run.state).toBe('dispatched');
    expect(run.endedAt).toBeUndefined();

    value(fleet.runs.setState(run.id, 'running'));
    const stopped = value(fleet.runs.setState(run.id, 'stopped', { terminalReason: 'human stopped it' }));
    expect(stopped.terminalReason).toBe('human stopped it');
    // Stopped has no outgoing transitions, so the run is over and dated.
    expect(stopped.endedAt).toBeGreaterThan(0);

    // A later note about a run that already ended must not move its end time.
    const noted = value(fleet.runs.setState(run.id, 'stopped', { terminalReason: 'recorded afterwards' }));
    expect(noted.endedAt).toBe(stopped.endedAt);
    expect(noted.terminalReason).toBe('recorded afterwards');

    const revived = fleet.runs.setState(run.id, 'running');
    expect(revived.ok).toBe(false);
    if (!revived.ok) expect(revived.message).toBe('A run that is stopped cannot become running.');
    fleet.close();
  });

  it('lists a task history oldest attempt first', () => {
    const fleet = store();
    const mission = seedMission(fleet);
    const task = value(fleet.tasks.create({ missionId: mission.id, title: 'A', description: '', cwd: '/r' }));
    value(fleet.runs.create({ missionId: mission.id, taskId: task.id, agent: 'claude' }));
    value(fleet.runs.create({ missionId: mission.id, taskId: task.id, agent: 'codex' }));
    expect(value(fleet.runs.listByTask(task.id)).map((run) => run.attempt)).toEqual([1, 2]);
    expect(value(fleet.runs.listByMission(mission.id))).toHaveLength(2);
    fleet.close();
  });
});

describe('worktree records', () => {
  const claim = (fleet: FleetStore, missionId: string, path: string) =>
    fleet.worktrees.create({
      repo: '/repo',
      path,
      branch: 'feat/x',
      baseSha: 'abc123',
      ownerMissionId: missionId,
    });

  it('records ownership and finds the live claim on a path', () => {
    const fleet = store();
    const mission = seedMission(fleet);
    const record = value(claim(fleet, mission.id, '/repo-worktrees/feat-x'));
    expect(record.state).toBe('active');
    expect(record.dirty).toBe(false);
    expect(value(fleet.worktrees.byPath(record.path))?.id).toBe(record.id);
    expect(value(fleet.worktrees.listByMission(mission.id))).toEqual([record]);
    fleet.close();
  });

  it('allows only one live claim per directory', () => {
    const fleet = store();
    const mission = seedMission(fleet);
    const first = value(claim(fleet, mission.id, '/repo-worktrees/shared'));
    expect(claim(fleet, mission.id, '/repo-worktrees/shared').ok).toBe(false);

    // Once the first claim is gone the path is free again, and the removed
    // record stays as history.
    value(fleet.worktrees.setState(first.id, 'archived'));
    value(fleet.worktrees.setState(first.id, 'removed'));
    expect(claim(fleet, mission.id, '/repo-worktrees/shared').ok).toBe(true);
    expect(value(fleet.worktrees.listByMission(mission.id))).toHaveLength(2);
    fleet.close();
  });

  it('refuses a state the contract does not allow', () => {
    const fleet = store();
    const mission = seedMission(fleet);
    const record = value(claim(fleet, mission.id, '/repo-worktrees/gone'));
    value(fleet.worktrees.setState(record.id, 'archived'));
    value(fleet.worktrees.setState(record.id, 'removed'));
    const back = fleet.worktrees.setState(record.id, 'active');
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.message).toBe('A worktree that is removed cannot become active.');
    fleet.close();
  });

  it('records what a reconciler saw on disk', () => {
    const fleet = store();
    const mission = seedMission(fleet);
    const record = value(claim(fleet, mission.id, '/repo-worktrees/dirty'));
    const seen = value(fleet.worktrees.markSeen(record.id, true, 1_700_000_000_000));
    expect(seen.dirty).toBe(true);
    expect(seen.lastSeenAt).toBe(1_700_000_000_000);
    expect(value(fleet.worktrees.get(record.id))?.dirty).toBe(true);
    fleet.close();
  });
});

describe('escalations', () => {
  it('records a request and settles it exactly once', () => {
    const fleet = store();
    const mission = seedMission(fleet);
    const raised = value(
      fleet.escalations.create({
        missionId: mission.id,
        source: 'child',
        request: 'git push',
        reason: 'The branch is ready for review.',
        severity: 'blocking',
      }),
    );
    expect(raised.resolution).toBe('pending');
    expect(value(fleet.escalations.listByMission(mission.id, 'pending'))).toEqual([raised]);

    const denied = value(fleet.escalations.resolve(raised.id, 'denied', 'Pushing needs a human.'));
    expect(denied.resolution).toBe('denied');
    expect(denied.resolvedAt).toBeGreaterThan(0);

    // A settled decision is a record, not a field to be overwritten.
    const again = fleet.escalations.resolve(raised.id, 'approved');
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.message).toBe('That escalation was already denied.');
    expect(fleet.escalations.resolve(raised.id, 'pending').ok).toBe(false);
    expect(value(fleet.escalations.listByMission(mission.id, 'pending'))).toEqual([]);
    fleet.close();
  });

  it('round-trips an expiry, which is what makes expired reachable', () => {
    const fleet = store();
    const mission = seedMission(fleet);
    const deadline = 1_800_000_000_000;
    const raised = value(
      fleet.escalations.create({
        missionId: mission.id,
        source: 'child',
        request: 'git push',
        reason: 'The branch is ready.',
        expiresAt: deadline,
      }),
    );
    expect(raised.expiresAt).toBe(deadline);
    expect(value(fleet.escalations.get(raised.id))?.expiresAt).toBe(deadline);
    expect(value(fleet.escalations.resolve(raised.id, 'expired', 'nobody answered')).resolution).toBe('expired');

    // No deadline means the request stands until someone answers it.
    const standing = value(
      fleet.escalations.create({ missionId: mission.id, source: 'manager', request: 'merge', reason: 'x' }),
    );
    expect(standing.expiresAt).toBeUndefined();
    fleet.close();
  });
});

describe('durability', () => {
  it('leaves no trace of a rolled-back transaction', () => {
    const fleet = store();
    const mission = seedMission(fleet);

    const rolled = transact(fleet.db, 'write two tasks then fail', () => {
      value(fleet.tasks.create({ missionId: mission.id, title: 'kept?', description: '', cwd: '/r' }));
      value(fleet.tasks.create({ missionId: mission.id, title: 'also kept?', description: '', cwd: '/r' }));
      throw new Error('half way through');
    });

    expect(rolled.ok).toBe(false);
    if (!rolled.ok) expect(rolled.message).toContain('half way through');
    expect(value(fleet.tasks.listByMission(mission.id))).toEqual([]);
    // The connection is still usable afterwards.
    expect(value(fleet.tasks.create({ missionId: mission.id, title: 'after', description: '', cwd: '/r' })).title).toBe('after');
    fleet.close();
  });

  it('undoes only the inner step when a nested transaction fails', () => {
    const fleet = store();
    const mission = seedMission(fleet);
    const outcome = transact(fleet.db, 'outer', () => {
      const kept = value(fleet.tasks.create({ missionId: mission.id, title: 'outer', description: '', cwd: '/r' }));
      // An inner refusal (illegal move) must not take the outer work with it.
      expect(fleet.tasks.setStatus(kept.id, 'accepted').ok).toBe(false);
      return kept.id;
    });
    expect(outcome.ok).toBe(true);
    expect(value(fleet.tasks.listByMission(mission.id)).map((task) => task.title)).toEqual(['outer']);
    fleet.close();
  });

  it('sees every entity again after closing and reopening', () => {
    const path = 'restart-all';
    const first = store(path);
    const mission = value(
      first.missions.create({ name: 'Everything', body: 'b', cwd: '/repo', budgetSec: 7200, budgetTokens: 500_000 }),
    );
    const task = value(first.tasks.create({ missionId: mission.id, title: 'A', description: 'd', cwd: '/r', dependsOn: ['x'] }));
    const run = value(first.runs.create({ missionId: mission.id, taskId: task.id, agent: 'claude', sessionId: 's1' }));
    const worktree = value(
      first.worktrees.create({ repo: '/repo', path: '/repo-worktrees/a', branch: 'b', baseSha: 'sha', ownerTaskId: task.id }),
    );
    const escalation = value(
      first.escalations.create({
        missionId: mission.id,
        source: 'manager',
        request: 'push',
        reason: 'ready',
        expiresAt: 1_900_000_000_000,
      }),
    );
    value(
      first.events.append({
        missionId: mission.id,
        taskId: task.id,
        runId: run.id,
        actor: 'human',
        kind: 'created',
        payload: { name: mission.name },
      }),
    );
    first.close();

    const second = store(path);
    expect(value(second.missions.get(mission.id))).toEqual(mission);
    expect(value(second.tasks.get(task.id))).toEqual(task);
    expect(value(second.runs.get(run.id))).toEqual(run);
    expect(value(second.worktrees.get(worktree.id))).toEqual(worktree);
    expect(value(second.escalations.get(escalation.id))).toEqual(escalation);
    expect(value(second.events.sinceForTask(task.id)).map((event) => event.kind)).toEqual(['created']);
    expect(value(second.events.since(0))[0]?.runId).toBe(run.id);
    second.close();
  });

  it('reports a closed connection as a result rather than throwing', () => {
    const fleet = store();
    const mission = seedMission(fleet);
    fleet.close();
    expect(() => fleet.missions.list()).not.toThrow();
    expect(fleet.missions.list().ok).toBe(false);
    expect(fleet.tasks.create({ missionId: mission.id, title: 'A', description: '', cwd: '/r' }).ok).toBe(false);
    expect(fleet.worktrees.setState('anything', 'idle').ok).toBe(false);
  });
});

describe('escalation idempotency', () => {
  it('returns the existing row rather than filing a second one', () => {
    // Found in review: the key was returned by a pure helper and the repo
    // generated a fresh UUID per call, so a pulse each minute filed a new
    // inbox row each minute. Uniqueness has to live at the write.
    const fleet = store();
    const mission = fleet.missions.create({ name: 'm', body: '', cwd: '/repo' });
    expect(mission.ok).toBe(true);
    if (!mission.ok) return;

    const raise = () =>
      fleet.escalations.create({
        missionId: mission.value.id,
        source: 'manager',
        request: 'approve Bash',
        reason: 'stuck',
        idempotencyKey: 'escalation:r1:approve Bash',
      });

    const first = raise();
    const second = raise();
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.id).toBe(first.value.id);
    expect(second.value.createdAt).toBe(first.value.createdAt);

    const all = fleet.escalations.listByMission(mission.value.id);
    expect(all.ok && all.value).toHaveLength(1);
  });

  it('still files separate escalations for different conditions', () => {
    const fleet = store();
    const mission = fleet.missions.create({ name: 'm', body: '', cwd: '/repo' });
    if (!mission.ok) return;
    const raise = (key: string) =>
      fleet.escalations.create({
        missionId: mission.value.id,
        source: 'manager',
        request: key,
        reason: 'stuck',
        idempotencyKey: key,
      });
    raise('a');
    raise('b');
    const all = fleet.escalations.listByMission(mission.value.id);
    expect(all.ok && all.value).toHaveLength(2);
  });

  it('does not deduplicate escalations raised without a key', () => {
    // A human raising the same concern twice is two concerns.
    const fleet = store();
    const mission = fleet.missions.create({ name: 'm', body: '', cwd: '/repo' });
    if (!mission.ok) return;
    for (let i = 0; i < 2; i++) {
      fleet.escalations.create({ missionId: mission.value.id, source: 'human', request: 'r', reason: 'x' });
    }
    const all = fleet.escalations.listByMission(mission.value.id);
    expect(all.ok && all.value).toHaveLength(2);
  });
});
