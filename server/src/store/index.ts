import type { DatabaseSync } from 'node:sqlite';
import { closeFleetDb, fleetDbPath, ok, openFleetDb, type StoreResult } from './db.js';
import { EscalationRepo } from './escalations.js';
import { FleetEventLog } from './events.js';
import { MissionRepo, TaskRepo } from './missions.js';
import { ChildRunRepo, WorktreeRepo } from './runs.js';

/**
 * One handle over the whole durable side, so callers take a dependency on the
 * store rather than on SQLite.
 *
 * `db` is exposed for the reconciler's future need to span repositories in one
 * transaction; everything a command handler needs is on the repositories.
 */
export interface FleetStore {
  readonly db: DatabaseSync;
  readonly missions: MissionRepo;
  readonly tasks: TaskRepo;
  readonly runs: ChildRunRepo;
  readonly worktrees: WorktreeRepo;
  readonly escalations: EscalationRepo;
  readonly events: FleetEventLog;
  close(): void;
}

/**
 * Opens (and migrates) the fleet database, reporting failure as a value.
 *
 * A caller that cannot open it still has a working server: sessions run, the
 * board works, and only the mission layer is unavailable. That is the whole
 * reason this returns a result instead of throwing at startup.
 */
export function openFleetStore(path: string = fleetDbPath()): StoreResult<FleetStore> {
  const opened = openFleetDb(path);
  if (!opened.ok) return opened;
  const db = opened.value;
  return ok({
    db,
    missions: new MissionRepo(db),
    tasks: new TaskRepo(db),
    runs: new ChildRunRepo(db),
    worktrees: new WorktreeRepo(db),
    escalations: new EscalationRepo(db),
    events: new FleetEventLog(db),
    close: () => closeFleetDb(db),
  });
}

export { fleetDbPath, openFleetDb, closeFleetDb } from './db.js';
export type { StoreResult } from './db.js';
export { MIGRATIONS, applyMigrations, latestVersion, schemaVersion, type Migration } from './migrations.js';
