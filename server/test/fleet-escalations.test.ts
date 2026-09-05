import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientCommand, Escalation, ServerEvent } from '@claudia/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { startFleet } from '../src/fleet/boot.js';
import { handleFleetCommand, isFleetCommand } from '../src/fleet/commands.js';
import { parseCommand } from '../src/command-schema.js';
import type { FleetStore } from '../src/store/index.js';

/**
 * The inbox the fleet had been filing into and nobody could read.
 *
 * The watchdog raises an escalation when a run is parked on a human — a
 * permission prompt the child cannot answer for itself, where retrying would
 * only spend a fresh turn to park on the same prompt. `EscalationRepo` could
 * list and resolve them from the first day. Nothing on the wire could, and no
 * note went into the timeline, so a watched mission stopped moving and said
 * nothing about why.
 */

const dir = mkdtempSync(join(tmpdir(), 'claudia-escalations-'));
const opened: FleetStore[] = [];
afterAll(() => {
  for (const store of opened) store.close();
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
function fleet(): { store: FleetStore; missionId: string } {
  const boot = startFleet(new Set(), join(dir, `db-${counter++}`, 'fleet.db'));
  if (!boot.store) throw new Error(boot.summary);
  opened.push(boot.store);
  const mission = boot.store.missions.create({ name: 'm', body: '', cwd: '/repo' });
  if (!mission.ok) throw new Error(mission.message);
  return { store: boot.store, missionId: mission.value.id };
}

function raise(store: FleetStore, missionId: string, over: { request?: string; severity?: 'info' | 'warning' | 'blocking' } = {}) {
  const filed = store.escalations.create({
    missionId,
    source: 'system',
    request: over.request ?? 'git push',
    reason: 'the run has been parked on you for six minutes',
    severity: over.severity ?? 'blocking',
  });
  if (!filed.ok) throw new Error(filed.message);
  return filed.value;
}

const escalationsIn = (events: ServerEvent[]): Escalation[] =>
  events.flatMap((e) => (e.type === 'escalations' ? e.escalations : []));
const notices = (events: ServerEvent[]): string[] =>
  events.flatMap((e) => (e.type === 'notice' ? [e.message] : []));

describe('reading the inbox', () => {
  it('answers with what is pending, which is what an inbox is', () => {
    const { store, missionId } = fleet();
    raise(store, missionId);
    const answered = handleFleetCommand({ type: 'list_escalations', missionId }, store);
    expect(escalationsIn(answered).map((e) => e.request)).toEqual(['git push']);
  });

  it('leaves settled ones out unless asked for them', () => {
    const { store, missionId } = fleet();
    const one = raise(store, missionId, { request: 'answered' });
    raise(store, missionId, { request: 'still waiting' });
    handleFleetCommand(
      { type: 'resolve_escalation', missionId, escalationId: one.id, resolution: 'approved' },
      store,
    );

    expect(escalationsIn(handleFleetCommand({ type: 'list_escalations', missionId }, store)).map((e) => e.request)).toEqual([
      'still waiting',
    ]);
    const settled = handleFleetCommand({ type: 'list_escalations', missionId, resolution: 'approved' }, store);
    expect(escalationsIn(settled).map((e) => e.request)).toEqual(['answered']);
  });
});

describe('answering one', () => {
  it('records the decision and hands back what is still waiting', () => {
    const { store, missionId } = fleet();
    const one = raise(store, missionId);
    const after = handleFleetCommand(
      { type: 'resolve_escalation', missionId, escalationId: one.id, resolution: 'denied', note: 'not on main' },
      store,
    );
    expect(escalationsIn(after)).toEqual([]);
    const read = store.escalations.get(one.id);
    expect(read.ok && read.value?.resolution).toBe('denied');
    expect(read.ok && read.value?.resolutionNote).toBe('not on main');
  });

  it('writes the answer into the timeline, beside the question', () => {
    // The log is what a person scrolls back through. A decision that changed
    // the fleet's behaviour and left no trace in it is not an audit trail.
    const { store, missionId } = fleet();
    const one = raise(store, missionId);
    handleFleetCommand({ type: 'resolve_escalation', missionId, escalationId: one.id, resolution: 'approved' }, store);
    const log = store.events.sinceForMission(missionId);
    if (!log.ok) throw new Error(log.message);
    const entry = log.value.find((e) => e.kind === 'escalation_approved');
    expect(entry).toBeDefined();
    // `human`, not `system`: this is somebody's decision, and the actor is the
    // whole point of recording it.
    expect(entry?.actor).toBe('human');
  });

  it('refuses to overwrite a decision somebody already made', () => {
    // The one thing an audit trail cannot do. The store says so in its own
    // words and the wire passes that through rather than rephrasing it.
    const { store, missionId } = fleet();
    const one = raise(store, missionId);
    handleFleetCommand({ type: 'resolve_escalation', missionId, escalationId: one.id, resolution: 'approved' }, store);
    const again = handleFleetCommand(
      { type: 'resolve_escalation', missionId, escalationId: one.id, resolution: 'denied' },
      store,
    );
    expect(notices(again).join(' ')).toContain('already approved');
  });

  it('says so when there is no such escalation, rather than failing silently', () => {
    const { store, missionId } = fleet();
    const answered = handleFleetCommand(
      { type: 'resolve_escalation', missionId, escalationId: 'no-such-thing', resolution: 'approved' },
      store,
    );
    expect(notices(answered).join(' ')).toContain('no-such-thing');
  });
});

describe('the wire', () => {
  it('routes both commands, so they are not handled-but-unreachable', () => {
    // The failure mode this repository has already had once: `set_task_status`
    // had a case and was missing from the command set, so the mission layer
    // was unreachable while looking complete.
    expect(isFleetCommand({ type: 'list_escalations', missionId: 'm1' })).toBe(true);
    expect(
      isFleetCommand({ type: 'resolve_escalation', missionId: 'm1', escalationId: 'e1', resolution: 'approved' }),
    ).toBe(true);
  });

  it('accepts the three resolutions a person can honestly mean', () => {
    for (const resolution of ['approved', 'denied', 'withdrawn']) {
      const parsed = parseCommand({ type: 'resolve_escalation', missionId: 'm1', escalationId: 'e1', resolution });
      expect(parsed.ok).toBe(true);
    }
  });

  it('refuses `pending`, which is not a resolution, and `expired`, which is the clock’s', () => {
    for (const resolution of ['pending', 'expired', 'maybe']) {
      const parsed = parseCommand({ type: 'resolve_escalation', missionId: 'm1', escalationId: 'e1', resolution });
      expect(parsed.ok).toBe(false);
    }
  });

  it('lets a reader ask for any resolution, including the two a person cannot set', () => {
    // Reading history is not making a decision: `expired` rows are exactly the
    // ones somebody would go looking for.
    for (const resolution of ['pending', 'expired', 'withdrawn']) {
      expect(parseCommand({ type: 'list_escalations', missionId: 'm1', resolution } as ClientCommand).ok).toBe(true);
    }
    expect(parseCommand({ type: 'list_escalations', missionId: 'm1', resolution: 'nonsense' }).ok).toBe(false);
  });
});
