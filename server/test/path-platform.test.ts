// FIRST, and for a reason this file would otherwise trip over: the filter for
// node:sqlite's "experimental feature" warning is installed when this module is
// evaluated, and it has to win that race against the import of `node:sqlite`
// below. `db.js` pulls it in for the same reason, but it is imported later here
// and would lose.
import '../src/store/experimental-warning.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

/**
 * Two paths the FOREIGN rules keep apart and this host's rules call one place.
 *
 * The merge is not one-directional, which is easy to get wrong: Windows merges
 * what POSIX separates by treating a backslash as a separator, and POSIX merges
 * what Windows separates by treating `C:` as an ordinary name, so `C:` (the
 * drive-relative "wherever we are on C") and `C:/` (the drive root) — two
 * different places on Windows — are one relative directory on Linux.
 *
 * So the pair has to be chosen for whichever platform is doing the merging. An
 * earlier version of this used the backslash pair on both, which cannot merge
 * on a POSIX host, and the case would have passed by never happening.
 */
const MERGED_HERE: readonly [string, string] =
  HOST_PLATFORM === 'win32' ? ['/wt/a\\b', '/wt/a/b'] : ['C:', 'C:/'];

/** Every row's key, so a refusal can be checked to have written nothing. */
function keysById(db: DatabaseSync): Record<string, string> {
  const rows = db.prepare('SELECT id, path_key FROM worktrees').all() as { id: string; path_key: string }[];
  return Object.fromEntries(rows.map((row) => [row.id, row.path_key]));
}

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

  it('refuses rather than choosing which of two live claims survives', () => {
    // `/wt/a\\b` and `/wt/a/b` are two directories to POSIX, where a backslash
    // is an ordinary character, and one directory to Windows, where it is a
    // separator. Both rows are REAL claims held by real tasks, so there is no
    // winner to pick: retiring the older one would discard an ownership record
    // nobody was told about, in the part of the fleet whose job is knowing who
    // owns what. Migration 5 retires its duplicates because they are one
    // directory recorded twice; these are not that.
    //
    // Driven with both platforms named, because this merge only ever happens in
    // one direction and a host-relative version would be inert on whichever
    // runner is the coarser one.
    const { fleet, missionId } = store();
    asIfWrittenUnder(fleet.db, 'posix', missionId, [
      { id: 'older', path: '/wt/a\\b', createdAt: 1 },
      { id: 'newer', path: '/wt/a/b', createdAt: 2 },
    ]);
    const before = keysById(fleet.db);

    expect(() => alignPathPlatform(fleet.db, 'win32')).toThrow(/one host cannot honour both/);

    // "and so is this database" has to be true, or the message is a lie: the
    // refusal throws inside the one transaction the whole realignment runs in.
    expect(keysById(fleet.db)).toEqual(before);
    expect(storedPathPlatform(fleet.db)).toBe('posix');
    const live = fleet.db
      .prepare("SELECT id FROM worktrees WHERE state <> 'removed' ORDER BY id")
      .all()
      .map((row) => String(row['id']));
    expect(live).toEqual(['newer', 'older']);
  });

  it('names the directories it will not merge, and a way out', () => {
    // The hazard of refusing is an unopenable file, and the answer to it is the
    // one migration 3 already gives for an unknown agent: name the rows and the
    // repair, because "UNIQUE constraint failed" is not something a person can
    // act on.
    const { fleet, missionId } = store();
    asIfWrittenUnder(fleet.db, 'posix', missionId, [
      { id: 'older', path: '/wt/a\\b', createdAt: 1 },
      { id: 'newer', path: '/wt/a/b', createdAt: 2 },
    ]);
    let message = '';
    try {
      alignPathPlatform(fleet.db, 'win32');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    // The paths exactly as the rows spell them, so a reader can find them, and
    // the ids, because the repair the message hands over takes an id.
    expect(message).toContain('older (/wt/a\\b)');
    expect(message).toContain('newer (/wt/a/b)');
    // Which rules it came from and which it is being read under, or the reader
    // cannot tell why two paths they can see are suddenly one place.
    expect(message).toContain('posix');
    expect(message).toContain('win32');
    expect(message).toContain("state='removed'");
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

  it('fails the open rather than merging two claims, and leaves the file alone', () => {
    // The end-to-end half of the refusal: a throw inside `alignPathPlatform`
    // has to come back as a failed open with the file closed and unchanged,
    // not as an exception out of `openFleetStore`. Testing the function alone
    // would prove none of that.
    const path = join(dir, 'refuses', 'fleet.db');
    const first = openFleetStore(path);
    if (!first.ok) throw new Error(first.message);
    const mission = first.value.missions.create({ name: 'm', body: '', cwd: '/repo' });
    if (!mission.ok) throw new Error(mission.message);
    const [one, two] = MERGED_HERE;
    asIfWrittenUnder(first.value.db, FOREIGN, mission.value.id, [
      { id: 'w-old', path: one, createdAt: 1 },
      { id: 'w-new', path: two, createdAt: 2 },
    ]);
    const before = keysById(first.value.db);
    closeFleetDb(first.value.db);

    const refused = openFleetStore(path);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.message).toContain('one host cannot honour both');
    expect(refused.message).toContain('w-old');
    expect(refused.message).toContain('w-new');

    // And the file really is untouched, which the message promises out loud.
    // Read with a plain connection: the assertion is about the bytes on disk,
    // and `openFleetDb` would try to realign again — and refuse again — before
    // handing anything back.
    const raw = new DatabaseSync(path);
    try {
      expect(keysById(raw)).toEqual(before);
      expect(storedPathPlatform(raw)).toBe(FOREIGN);
    } finally {
      raw.close();
    }
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
