import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startFleet } from '../src/fleet/boot.js';
import { expireEscalations } from '../src/fleet/escalation-expiry.js';
import type { FleetStore } from '../src/store/index.js';

/**
 * The clock's answer to a question nobody answered.
 *
 * `expiresAt` was persisted, `expired` was legal in `ESCALATION_RESOLUTIONS`
 * and in the schema's CHECK constraint, and no code path ever wrote it — the
 * schema's own comment says as much. A request with a deadline therefore
 * behaved exactly like one without.
 */

const dir = mkdtempSync(join(tmpdir(), 'claudia-expiry-'));
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

function file(store: FleetStore, missionId: string, expiresAt?: number): string {
  const filed = store.escalations.create({
    missionId,
    source: 'system',
    request: 'git push',
    reason: 'the child asked to push',
    severity: 'blocking',
    idempotencyKey: `k-${counter++}`,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
  if (!filed.ok) throw new Error(filed.message);
  return filed.value.id;
}

const pendingCount = (store: FleetStore, missionId: string): number => {
  const pending = store.escalations.listByMission(missionId, 'pending');
  return pending.ok ? pending.value.length : -1;
};

describe('expiring escalations', () => {
  it('expires one whose deadline has passed', () => {
    const { store, missionId } = fleet();
    const id = file(store, missionId, 500);
    expect(expireEscalations(store, missionId, 900)).toBe(1);
    const after = store.escalations.get(id);
    expect(after.ok && after.value?.resolution).toBe('expired');
  });

  it('leaves one whose deadline has not', () => {
    const { store, missionId } = fleet();
    file(store, missionId, 1_000);
    expect(expireEscalations(store, missionId, 900)).toBe(0);
    expect(pendingCount(store, missionId)).toBe(1);
  });

  it('leaves one with no deadline standing until somebody answers it', () => {
    const { store, missionId } = fleet();
    file(store, missionId);
    expect(expireEscalations(store, missionId, Number.MAX_SAFE_INTEGER)).toBe(0);
    expect(pendingCount(store, missionId)).toBe(1);
  });

  it('writes a timeline line, so a request does not just vanish from the board', () => {
    const { store, missionId } = fleet();
    file(store, missionId, 500);
    expireEscalations(store, missionId, 900);
    const events = store.events.sinceForMission(missionId);
    expect(events.ok && events.value.some((e) => e.kind === 'escalation_expired')).toBe(true);
  });

  it('does not write the same line twice when the pass runs again', () => {
    // Keyed on the escalation, and the second pass finds nothing pending
    // anyway — but a resolved row reappearing would double the log.
    const { store, missionId } = fleet();
    file(store, missionId, 500);
    expireEscalations(store, missionId, 900);
    expireEscalations(store, missionId, 1_000);
    const events = store.events.sinceForMission(missionId);
    const lines = events.ok ? events.value.filter((e) => e.kind === 'escalation_expired') : [];
    expect(lines).toHaveLength(1);
  });

  it('leaves an escalation a human already answered alone', () => {
    const { store, missionId } = fleet();
    const id = file(store, missionId, 500);
    const answered = store.escalations.resolve(id, 'approved', 'go ahead');
    expect(answered.ok).toBe(true);
    expect(expireEscalations(store, missionId, 900)).toBe(0);
    const after = store.escalations.get(id);
    expect(after.ok && after.value?.resolution).toBe('approved');
  });

  it('treats a deadline nobody can read as no deadline at all', () => {
    // The column is INTEGER in a STRICT table, so a non-finite deadline is
    // persisted as NULL and reads back as `undefined`: an escalation asked for
    // with an unreadable expiry stands until somebody answers it. That is the
    // safe direction — the alternative is retiring the one thing a human is
    // supposed to answer on the strength of a number nobody can read — but it
    // happens in SQLite rather than here, so it is asserted rather than
    // assumed. `expireEscalations` keeps its own `isFinite` guard for the same
    // reason; this test does not reach it.
    const { store, missionId } = fleet();
    file(store, missionId, Number.NaN);
    const pending = store.escalations.listByMission(missionId, 'pending');
    expect(pending.ok && pending.value[0]?.expiresAt).toBeUndefined();
    expect(expireEscalations(store, missionId, Number.MAX_SAFE_INTEGER)).toBe(0);
    expect(pendingCount(store, missionId)).toBe(1);
  });
});
