import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startFleet } from '../src/fleet/boot.js';
import { note } from '../src/fleet/pulse-report.js';

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
