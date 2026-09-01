import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { HOST_PLATFORM, worktreePathKey, type PathPlatform } from '../src/path-key.js';
import { closeFleetDb, openFleetDb } from '../src/store/db.js';
import { openFleetStore } from '../src/store/index.js';
import { MIGRATIONS } from '../src/store/migrations.js';
import { alignPathPlatform, storedPathPlatform } from '../src/store/path-platform.js';
import { DERIVED_WORKTREE_KEYS } from '../src/store/schema-constraints.js';

/**
 * A worktree key is a function of the path AND the platform, and only the path
 * is written down. These are the cases where that gap shows: the same file,
 * opened from the other side.
 *
 * Every case here drives the platform explicitly rather than reading the host,
 * because a test that is inert on the machine it runs on is not a test — the
 * exact trap that let an earlier path bug in this repo look correct on Linux
 * and fail on a Windows runner.
 */

const dir = mkdtempSync(join(tmpdir(), 'claudia-path-platform-'));
const opened: DatabaseSync[] = [];
afterAll(() => {
  for (const db of opened) closeFleetDb(db);
  rmSync(dir, { recursive: true, force: true });
});

/** Whichever set of rules this machine is NOT using. */
const FOREIGN: PathPlatform = HOST_PLATFORM === 'win32' ? 'posix' : 'win32';

let counter = 0;
function store(name = `db-${counter++}`) {
  const result = openFleetStore(join(dir, name, 'fleet.db'));
  if (!result.ok) throw new Error(result.message);
  opened.push(result.value.db);
  const mission = result.value.missions.create({ name: 'm', body: '', cwd: '/repo' });
  if (!mission.ok) throw new Error(mission.message);
  return { fleet: result.value, missionId: mission.value.id };
}

/**
 * Writes worktree rows the way a DIFFERENT machine would have written them.
 *
 * The derived-key trigger computes with THIS host's rules, which is right for
 * a live insert and wrong for staging a file that arrived from elsewhere — the
 * whole scenario being tested. So it comes down for the insert and goes back
 * afterwards, which is what the file looks like when another machine wrote
 * these rows and this one opened it.
 */
function asIfWrittenUnder(
  db: DatabaseSync,
  platform: PathPlatform,
  missionId: string,
  rows: readonly { id: string; path: string; createdAt: number }[],
): void {
  db.exec('DROP TRIGGER IF EXISTS worktrees_path_key_is_derived');
  const insert = db.prepare(
    `INSERT INTO worktrees (id, repo, path, path_key, branch, base_sha, owner_mission_id, state, dirty, last_seen_at, created_at)
     VALUES (?, '/repo', ?, ?, 'b', 'a', ?, 'active', 0, 1, ?)`,
  );
  for (const row of rows) {
    insert.run(row.id, row.path, worktreePathKey(row.path, platform), missionId, row.createdAt);
  }
  db.prepare('INSERT INTO fleet_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    'path_platform',
    platform,
  );
  db.exec(DERIVED_WORKTREE_KEYS);
}

describe('a file records which platform its keys were written under', () => {
  it('stamps a new file with this host, and does nothing on the next open', () => {
    const { fleet } = store();
    expect(storedPathPlatform(fleet.db)).toBe(HOST_PLATFORM);
    // The second call is the every-open case: one read, no writes, no work.
    expect(alignPathPlatform(fleet.db)).toBe(false);
  });

  it('leaves a file older than the table alone rather than throwing', () => {
    // Reachable: openFleetDb takes a subset of the migration list so a test can
    // open a file at an older version, which is the only way to exercise a
    // migration against the real list rather than a synthetic one.
    const older = openFleetDb(
      join(dir, 'pre-stamp', 'fleet.db'),
      MIGRATIONS.filter((m) => m.version <= 7),
    );
    if (!older.ok) throw new Error(older.message);
    opened.push(older.value);
    expect(storedPathPlatform(older.value)).toBeUndefined();
    expect(alignPathPlatform(older.value)).toBe(false);
  });
});

describe('opening a file written under the other platform', () => {
  it('finds worktrees again that the wrong rules made invisible', () => {
    // The defect, before the realignment existed: the keys in the file were
    // computed by one platform and the lookup computes with another, so
    // `byPath` asks for a key the file does not contain and the row is gone —
    // while the unique index, which is over that same key, no longer stops the
    // directory being claimed a second time.
    const { fleet, missionId } = store();
    asIfWrittenUnder(fleet.db, FOREIGN, missionId, [{ id: 'w1', path: '/wt/Mixed/Case', createdAt: 1 }]);

    const missed = fleet.worktrees.byPath('/wt/Mixed/Case');
    expect(missed.ok && missed.value).toBeUndefined();

    expect(alignPathPlatform(fleet.db)).toBe(true);
    expect(storedPathPlatform(fleet.db)).toBe(HOST_PLATFORM);

    const found = fleet.worktrees.byPath('/wt/Mixed/Case');
    expect(found.ok && found.value?.id).toBe('w1');
    // The path a human reads is untouched; only the derived key moved.
    expect(found.ok && found.value?.path).toBe('/wt/Mixed/Case');
  });

  it('keeps one live claim when the new rules merge two directories', () => {
    // `/wt/a\\b` and `/wt/a/b` are two directories to POSIX, where a backslash
    // is an ordinary character, and one directory to Windows, where it is a
    // separator. A file that legitimately holds both, opened on Windows, has
    // two live rows for one place — and only one of them can keep the claim.
    //
    // Driven with both platforms named, because this merge only ever happens
    // in one direction and a host-relative version of it would be inert on
    // whichever runner is the coarser one.
    const { fleet, missionId } = store();
    asIfWrittenUnder(fleet.db, 'posix', missionId, [
      { id: 'older', path: '/wt/a\\b', createdAt: 1 },
      { id: 'newer', path: '/wt/a/b', createdAt: 2 },
    ]);

    expect(alignPathPlatform(fleet.db, 'win32')).toBe(true);

    const live = fleet.db
      .prepare("SELECT id FROM worktrees WHERE state <> 'removed' ORDER BY id")
      .all()
      .map((row) => String(row['id']));
    expect(live).toEqual(['newer']);
    // Retired, not deleted: it is still a record of what happened.
    expect(fleet.db.prepare('SELECT COUNT(*) AS n FROM worktrees').get()?.['n']).toBe(2);
  });

  it('puts the index and the immutability trigger back', () => {
    // The realignment takes both down to do its work. Leaving either off would
    // trade a stale key for a permanently unenforced one — the guarantee gone
    // in exactly the file that just proved it needed it.
    const { fleet, missionId } = store();
    asIfWrittenUnder(fleet.db, FOREIGN, missionId, [{ id: 'w1', path: '/wt/one', createdAt: 1 }]);
    expect(alignPathPlatform(fleet.db)).toBe(true);

    expect(() => fleet.db.prepare("UPDATE worktrees SET path = '/wt/two' WHERE id = 'w1'").run()).toThrow(
      /cannot be changed/,
    );
    const second = fleet.worktrees.create({
      repo: '/repo',
      path: '/wt/one/',
      branch: 'b',
      baseSha: 'a',
      ownerMissionId: missionId,
      dirty: false,
    });
    expect(second.ok).toBe(false);
  });

  it('realigns on the way in, not only when asked', () => {
    // The end-to-end shape: a file written elsewhere, closed, and picked up by
    // an ordinary open. Asserted through `openFleetStore` because a test that
    // only ever calls the function directly would pass just as well with the
    // call site missing from `openFleetDb`, which is the half that makes any
    // of this reach a user.
    const path = join(dir, 'reopened', 'fleet.db');
    const first = openFleetStore(path);
    if (!first.ok) throw new Error(first.message);
    const mission = first.value.missions.create({ name: 'm', body: '', cwd: '/repo' });
    if (!mission.ok) throw new Error(mission.message);
    asIfWrittenUnder(first.value.db, FOREIGN, mission.value.id, [{ id: 'w1', path: '/wt/Elsewhere', createdAt: 1 }]);
    closeFleetDb(first.value.db);

    const second = openFleetStore(path);
    if (!second.ok) throw new Error(second.message);
    opened.push(second.value.db);
    expect(storedPathPlatform(second.value.db)).toBe(HOST_PLATFORM);
    const found = second.value.worktrees.byPath('/wt/Elsewhere');
    expect(found.ok && found.value?.id).toBe('w1');
  });

  it('is stable when the file goes back to where it came from', () => {
    // A round trip must not keep rewriting: the second visit to a platform has
    // to agree with the first, or every open of a shared file churns the whole
    // table and the stamp means nothing.
    const { fleet, missionId } = store();
    asIfWrittenUnder(fleet.db, HOST_PLATFORM, missionId, [{ id: 'w1', path: '/wt/round/trip', createdAt: 1 }]);
    const key = () => String(fleet.db.prepare("SELECT path_key FROM worktrees WHERE id = 'w1'").get()?.['path_key']);
    const home = key();

    expect(alignPathPlatform(fleet.db, FOREIGN)).toBe(true);
    expect(alignPathPlatform(fleet.db, HOST_PLATFORM)).toBe(true);
    expect(key()).toBe(home);
    expect(alignPathPlatform(fleet.db)).toBe(false);
  });
});
