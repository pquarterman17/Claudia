import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildRun } from '@claudia/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { startFleet } from '../src/fleet/boot.js';
import { pulseMission, type SessionFacts } from '../src/fleet/pulse.js';
import { nextAction } from '../src/fleet/watchdog-action.js';
import { DEFAULT_WATCHDOG } from '../src/fleet/watchdog-policy.js';
import { assess, type RunObservation } from '../src/fleet/watchdog.js';
import type { FleetStore } from '../src/store/index.js';

/**
 * A fleet child could not succeed.
 *
 * Nothing in the server ever wrote `reported`, to a run or to a task. A child
 * that did its work perfectly went idle, sat out `silentAfterMs`, and was read
 * as a silent run: retried with the same brief at full price, again, until the
 * attempts ran out and the task was failed. Every state past `running` —
 * `reported`, and therefore `accepted` — was unreachable, which made the plan's
 * whole completion contract decorative.
 *
 * `idle` is the SDK's word for a turn that ENDED, not for a pause between tool
 * calls, so for a child given one brief it is the child saying it is finished.
 * That is a CLAIM, which is why it lands in `reported` and not in `accepted`.
 */

const dir = mkdtempSync(join(tmpdir(), 'claudia-succeed-'));
const opened: FleetStore[] = [];
afterAll(() => {
  for (const store of opened) store.close();
  rmSync(dir, { recursive: true, force: true });
});

const NOW = 1_000_000;

function run(over: Partial<ChildRun> = {}): ChildRun {
  return {
    id: 'r1',
    missionId: 'm1',
    taskId: 't1',
    sessionId: 's1',
    agent: 'claude',
    attempt: 1,
    state: 'running',
    startedAt: NOW - 600_000,
    ...over,
  } as ChildRun;
}

function seen(over: Partial<RunObservation> = {}): RunObservation {
  return { run: run(), sessionAlive: true, now: NOW, ...over };
}

describe('reading a finished child', () => {
  it('calls a session that has been idle since it worked done', () => {
    const health = assess(seen({ state: 'idle', lastActivityAt: NOW - 60_000 }));
    expect(health.kind).toBe('done');
  });

  it('does not call a session that is still working done', () => {
    for (const state of ['working', 'starting', 'awaiting_approval'] as const) {
      expect(assess(seen({ state, lastActivityAt: NOW - 60_000 })).kind).not.toBe('done');
    }
  });

  it('does not call a session done when nobody said what state it is in', () => {
    // Absent means "nobody said", which has to read as not-idle — that is the
    // behaviour every caller had before the field existed.
    expect(assess(seen({ lastActivityAt: NOW - 60_000 })).kind).not.toBe('done');
  });

  it('waits out the grace, so a tile idle before its first turn is not "finished"', () => {
    // A session is created, reads idle for a moment, and starts working. A
    // finished child stays idle, so it reports one tick later; a starting one
    // has moved on by then.
    const health = assess(seen({ state: 'idle', lastActivityAt: NOW - 1_000 }));
    expect(health.kind).not.toBe('done');
  });

  it('does not call a run done that never did anything', () => {
    // No activity after the reservation was written: there is no turn to have
    // finished. This is a run whose child never came up, and the orphan and
    // silence paths are the ones that should have it.
    const health = assess(seen({ state: 'idle', lastActivityAt: NOW - 600_000, run: run({ startedAt: NOW - 60_000 }) }));
    expect(health.kind).not.toBe('done');
  });

  it('is an orphan first if its session is gone, because the fix is different', () => {
    expect(assess(seen({ state: 'idle', sessionAlive: false, lastActivityAt: NOW - 60_000 })).kind).toBe('orphaned');
  });

  it('is stuck first if it is parked on a human, because nothing finished', () => {
    const health = assess(
      seen({ state: 'idle', lastActivityAt: NOW - 60_000, pendingApproval: 'Bash', pendingSince: NOW - 600_000 }),
    );
    expect(health.kind).toBe('stuck');
  });
});

describe('what is done about it', () => {
  it('reports, rather than retrying or accepting', () => {
    const action = nextAction({ kind: 'done', reason: 'the child finished its turn' }, seen({ state: 'idle' }));
    expect(action.kind).toBe('report');
    if (action.kind !== 'report') throw new Error('unreachable');
    // The run ends — a finished run left `running` holds a concurrency slot
    // for the life of the mission — and the task lands on a claim, not on a
    // verdict.
    expect(action.terminal).toBe('reported');
    expect(action.task.to).toBe('reported');
  });

  it('records a finished child even when the watchdog cannot read its own policy', () => {
    // Deliberately decided before the policy revalidation: writing down that a
    // child finished spends nothing and needs no arithmetic. Escalating here
    // would lose the work AND the attempt.
    const action = nextAction(
      { kind: 'done', reason: 'the child finished its turn' },
      seen({ state: 'idle' }),
      { ...DEFAULT_WATCHDOG, retryBaseMs: Number.NaN },
    );
    expect(action.kind).toBe('report');
  });
});

describe('the whole way through, on a real store', () => {
  let counter = 0;
  function fixture() {
    const boot = startFleet(new Set(), join(dir, `db-${counter++}`, 'fleet.db'));
    if (!boot.store) throw new Error(boot.summary);
    const store = boot.store;
    opened.push(store);
    const mission = store.missions.create({ name: 'm', body: '', cwd: '/repo' });
    if (!mission.ok) throw new Error(mission.message);
    const watched = store.missions.setWatch(mission.value.id, 'watching');
    if (!watched.ok) throw new Error(watched.message);

    const task = store.tasks.create({ missionId: mission.value.id, title: 't', description: '', cwd: '/repo' });
    if (!task.ok) throw new Error(task.message);
    for (const status of ['ready', 'running'] as const) {
      const moved = store.tasks.setStatus(task.value.id, status);
      if (!moved.ok) throw new Error(moved.message);
    }
    const reserved = store.runs.create({
      missionId: mission.value.id,
      taskId: task.value.id,
      agent: 'claude',
      attempt: 1,
      state: 'dispatched',
    });
    if (!reserved.ok) throw new Error(reserved.message);
    const attached = store.runs.attachSession(reserved.value.id, 'sess-1');
    if (!attached.ok) throw new Error(attached.message);
    const running = store.runs.setState(reserved.value.id, 'running');
    if (!running.ok) throw new Error(running.message);
    // Aged, so the child's activity falls AFTER the reservation was written.
    // A run created this millisecond has a `startedAt` later than any activity
    // the fixture can describe, and "did nothing since it started" is exactly
    // the case that must NOT read as finished.
    store.db.prepare('UPDATE child_runs SET started_at = ? WHERE id = ?').run(Date.now() - 600_000, running.value.id);
    return { store, mission: watched.value, task: task.value, run: running.value };
  }

  it('moves the run and the task to reported, and says so in the log', async () => {
    const { store, mission, task, run: reserved } = fixture();
    const now = Date.now();
    const facts = new Map<string, SessionFacts>([
      ['sess-1', { lastActivityAt: now - 60_000, state: 'idle' }],
    ]);

    const result = await pulseMission(mission, {
      store,
      policy: { maxChildren: 4, maxAttempts: 3 },
      observeSessions: () => facts,
      launch: async () => true,
      now: () => now,
    });

    expect(result?.reported).toBe(1);
    const after = store.runs.get(reserved.id);
    expect(after.ok && after.value?.state).toBe('reported');
    const moved = store.tasks.get(task.id);
    expect(moved.ok && moved.value?.status).toBe('reported');

    const log = store.events.sinceForMission(mission.id);
    if (!log.ok) throw new Error(log.message);
    expect(log.value.map((e) => e.kind)).toContain('task_reported');
  });

  it('frees the slot it was holding, which is the point of terminalizing it', async () => {
    // A finished run left `running` is a concurrency slot held for the life of
    // the mission — the same wedge the retry and give-up paths close.
    const { store, mission } = fixture();
    const now = Date.now();
    const facts = new Map<string, SessionFacts>([
      ['sess-1', { lastActivityAt: now - 60_000, state: 'idle' }],
    ]);
    await pulseMission(mission, {
      store,
      policy: { maxChildren: 4, maxAttempts: 3 },
      observeSessions: () => facts,
      launch: async () => true,
      now: () => now,
    });
    const runs = store.runs.listByMission(mission.id);
    if (!runs.ok) throw new Error(runs.message);
    expect(runs.value.filter((r) => r.state === 'running' || r.state === 'dispatched')).toEqual([]);
  });

  it('does not accept anything — a claim is not a verdict', async () => {
    const { store, mission, task } = fixture();
    const now = Date.now();
    await pulseMission(mission, {
      store,
      policy: { maxChildren: 4, maxAttempts: 3 },
      observeSessions: () => new Map([['sess-1', { lastActivityAt: now - 60_000, state: 'idle' as const }]]),
      launch: async () => true,
      now: () => now,
    });
    const moved = store.tasks.get(task.id);
    expect(moved.ok && moved.value?.status).not.toBe('accepted');
  });
});
