import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { startFleet } from '../src/fleet/boot.js';
import { handleFleetCommand, isFleetCommand } from '../src/fleet/commands.js';
import { closeFleetDb, openFleetDb } from '../src/store/db.js';
import { applyMigrations, MIGRATIONS, schemaVersion } from '../src/store/migrations.js';
import { openFleetStore, type FleetStore } from '../src/store/index.js';

/**
 * The command a mission's finished work is checked with.
 *
 * `acceptance.ts` has judged evidence since the first fleet PR, and nothing
 * ever wrote `evidence.tests` — so `missingEvidence` reported "test results"
 * every time, `judge`'s reject-on-failing-checks branch could not be reached by
 * any input, and every verdict the fleet ever recorded was `needs_human`. The
 * fleet could see a diff; it could not tell whether the diff was any good.
 *
 * Absent is still the default. This runs unattended in a directory an agent has
 * been writing to, so it has to be something a person wrote down on purpose
 * rather than something guessed from the repository.
 */

const dir = mkdtempSync(join(tmpdir(), 'claudia-mission-verify-'));
const stores: FleetStore[] = [];
const dbs: DatabaseSync[] = [];
afterAll(() => {
  for (const store of stores) store.close();
  for (const db of dbs) closeFleetDb(db);
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
function fleet(): FleetStore {
  const boot = startFleet(new Set(), join(dir, `db-${counter++}`, 'fleet.db'));
  if (!boot.store) throw new Error(boot.summary);
  stores.push(boot.store);
  return boot.store;
}

describe('storing it', () => {
  it('is absent unless somebody says otherwise', () => {
    const store = fleet();
    const mission = store.missions.create({ name: 'm', body: '', cwd: '/repo' });
    if (!mission.ok) throw new Error(mission.message);
    expect(mission.value.verify).toBeUndefined();
  });

  it('keeps what it was given, and survives a re-read', () => {
    const store = fleet();
    const mission = store.missions.create({ name: 'm', body: '', cwd: '/repo', verify: '  npm test  ' });
    if (!mission.ok) throw new Error(mission.message);
    expect(mission.value.verify).toBe('npm test');
    const read = store.missions.get(mission.value.id);
    expect(read.ok && read.value?.verify).toBe('npm test');
  });

  it('can be set later, and cleared', () => {
    // The field most likely to be got right on the second attempt: a mission
    // is described before anybody knows what its checks are called.
    const store = fleet();
    const mission = store.missions.create({ name: 'm', body: '', cwd: '/repo' });
    if (!mission.ok) throw new Error(mission.message);

    const set = store.missions.setVerify(mission.value.id, './scripts/check.sh --ci');
    expect(set.ok && set.value.verify).toBe('./scripts/check.sh --ci');

    // Clearing matters as much as setting: a command that has become wrong
    // rejects good work, and there has to be a way back to "nobody checks".
    const cleared = store.missions.setVerify(mission.value.id, '');
    expect(cleared.ok && cleared.value.verify).toBeUndefined();
    const read = store.missions.get(mission.value.id);
    expect(read.ok && read.value?.verify).toBeUndefined();
  });

  it('refuses a command it could not run as written', () => {
    // Refused where it is TYPED rather than discovered later as a verdict.
    // Parsed as arguments, `npm test && npm run lint` hands npm four words it
    // does not understand, npm exits non-zero, and every finished child is
    // rejected for the rest of the mission's life.
    const store = fleet();
    const refused = store.missions.create({ name: 'm', body: '', cwd: '/repo', verify: 'npm test && npm run lint' });
    expect(refused.ok).toBe(false);

    const mission = store.missions.create({ name: 'm', body: '', cwd: '/repo' });
    if (!mission.ok) throw new Error(mission.message);
    const late = store.missions.setVerify(mission.value.id, 'rm -rf / ; echo done');
    expect(late.ok).toBe(false);
    // And the mission is left as it was, rather than half-set.
    const read = store.missions.get(mission.value.id);
    expect(read.ok && read.value?.verify).toBeUndefined();
  });
});

describe('over the wire', () => {
  it('is a command the fleet router owns, and answers with the mission list', () => {
    // The pin that caught this being added to the switch and not to the set:
    // a command claimed by neither is swallowed silently.
    expect(isFleetCommand({ type: 'set_mission_verify', missionId: 'm', verify: 'npm test' })).toBe(true);

    const store = fleet();
    const mission = store.missions.create({ name: 'm', body: '', cwd: '/repo' });
    if (!mission.ok) throw new Error(mission.message);
    const events = handleFleetCommand(
      { type: 'set_mission_verify', missionId: mission.value.id, verify: 'npm test' },
      store,
    );
    const listed = events.find((e) => e.type === 'missions');
    expect(listed).toBeDefined();
    const read = store.missions.get(mission.value.id);
    expect(read.ok && read.value?.verify).toBe('npm test');
  });

  it('explains a refusal instead of failing silently', () => {
    const store = fleet();
    const mission = store.missions.create({ name: 'm', body: '', cwd: '/repo' });
    if (!mission.ok) throw new Error(mission.message);
    const events = handleFleetCommand(
      { type: 'set_mission_verify', missionId: mission.value.id, verify: 'a && b' },
      store,
    );
    const notice = events.find((e) => e.type === 'notice');
    expect(notice).toBeDefined();
    expect(notice && 'message' in notice ? notice.message : '').toMatch(/one program/);
  });
});

describe('a database written before missions had one', () => {
  it('gains the column, and reads back as nobody checking', () => {
    // Absent rather than a default, because a mission that predates the column
    // genuinely has no command — and inventing one would have the fleet
    // running something in a worktree its owner never asked for.
    const path = join(dir, 'older', 'fleet.db');
    const version = MIGRATIONS.find((m) => m.name === 'mission-verify')?.version ?? 0;
    expect(version).toBeGreaterThan(0);
    const opened = openFleetDb(path, MIGRATIONS.filter((m) => m.version < version));
    if (!opened.ok) throw new Error(opened.message);
    const db = opened.value;
    dbs.push(db);

    db.prepare(
      `INSERT INTO missions (id, name, body, status, watch, pulse_sec, max_children, cwd, agent, created_at, updated_at)
       VALUES ('m-old', 'old', '', 'active', 'paused', 60, 4, '/repo', 'claude', 1, 1)`,
    ).run();

    applyMigrations(db);
    expect(schemaVersion(db)).toBe(MIGRATIONS[MIGRATIONS.length - 1]?.version);
    const row = db.prepare("SELECT verify FROM missions WHERE id = 'm-old'").get();
    expect(row?.['verify']).toBeNull();
  });

  it('still opens through the normal path afterwards', () => {
    const store = openFleetStore(join(dir, 'older', 'fleet.db'));
    if (!store.ok) throw new Error(store.message);
    stores.push(store.value);
    const read = store.value.missions.get('m-old');
    expect(read.ok).toBe(true);
    expect(read.ok && read.value?.verify).toBeUndefined();
  });
});
