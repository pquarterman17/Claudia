import type { DatabaseSync } from 'node:sqlite';
import { HOST_PLATFORM, type PathPlatform } from '../path-key.js';
import { IMMUTABLE_WORKTREE_PATHS, recanonicaliseWorktreeKeys, WORKTREE_LIVE_PATH_INDEX } from './schema-constraints.js';

/**
 * Which platform's spelling rules a file's worktree keys were written under.
 *
 * `worktreePathKey` folds case and separators on Windows and neither on POSIX,
 * because it has to: `/repo/Work` and `/repo/work` are two directories on Linux
 * and one on Windows, and `a\b` is a filename on one and a path on the other.
 * So the key is a function of the path AND the host, and the host is not
 * written down anywhere in the file the keys live in.
 *
 * Measured on a v7 file: keys written on Windows, then opened with POSIX rules,
 * and `byPath` missed every row — the lookup computes a key the file does not
 * contain. Worse than a missed lookup, the unique index stops meaning anything:
 * it is over `path_key`, so a directory already held under its Windows key can
 * be claimed a second time under its POSIX one. Two live claims on one
 * checkout, which is the failure the key exists to prevent, reached without
 * anything being wrong with the key itself.
 *
 * The answer is to write the platform down and realign when it changes. That
 * makes the guarantee "one live claim per directory, under the rules of
 * whoever is currently looking", which is the strongest true statement
 * available: nothing can make one key correct for both platforms at once,
 * because the two disagree about which directories are the same.
 */
export const FLEET_META = `
CREATE TABLE fleet_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
`;

const PATH_PLATFORM = 'path_platform';

/** What the file says its keys were written under. `undefined` if it has never said. */
export function storedPathPlatform(db: DatabaseSync): PathPlatform | undefined {
  if (!hasFleetMeta(db)) return undefined;
  const row = db.prepare('SELECT value FROM fleet_meta WHERE key = ?').get(PATH_PLATFORM);
  const value = row?.['value'];
  // Anything else is a value this build did not write, and guessing which
  // platform it meant would be worse than rewriting the keys we can compute.
  return value === 'win32' || value === 'posix' ? value : undefined;
}

/**
 * Brings a file's worktree keys under this host's rules, and says so if it did.
 *
 * Runs on every open rather than as a migration, because the platform can
 * change without the schema changing — the same file opened from Windows and
 * from WSL is one `user_version` and two answers. A migration runs once; this
 * question is asked again every time the file is picked up.
 *
 * The index and the immutability trigger both come down for the rewrite. The
 * index, because a rewrite passes through intermediate states that hold a
 * duplicate the finished state does not — row A taking the key row B has not
 * yet given up. The trigger, because it exists precisely to forbid what this
 * does, and the honest way past a rule is to lift it deliberately, inside the
 * transaction that puts it back, rather than to write an exemption into it that
 * is then always there.
 *
 * Realigning can retire a row: two directories that POSIX keeps apart can be
 * one directory to Windows, and only one of them can hold the claim. Newest
 * wins, the rest are marked `removed`, and nothing is deleted — the same
 * decision migration 5 took, for the same reason, that a file must not become
 * unopenable over a conflict the schema itself allowed to exist. A row retired
 * on the way to Windows is not revived on the way back; its directory is simply
 * claimable again.
 */
export function alignPathPlatform(db: DatabaseSync, platform: PathPlatform = HOST_PLATFORM): boolean {
  // A file older than the migration that adds the table has nothing to align
  // against. Reachable, and not only in theory: `openFleetDb` takes a subset of
  // the migration list so a test can open a file at an older version and
  // upgrade it, which is the only way to exercise a migration against the real
  // list rather than a synthetic one.
  if (!hasFleetMeta(db)) return false;
  if (storedPathPlatform(db) === platform) return false;

  // Its own transaction only when it is not already inside one. Called from
  // `openFleetDb`, where nothing has begun; `transact` lives in db.ts and
  // importing it here would close a cycle between the two modules.
  const owns = !db.isTransaction;
  if (owns) db.exec('BEGIN IMMEDIATE');
  try {
    // Re-read INSIDE the write lock, for the reason the migration runner
    // already gives for doing the same: the check above was made before
    // anything was serialised, so the old sidecar still holding the file and
    // the new one starting up — the restart this store exists for — both saw
    // the stale platform, and the loser realigned a file that had already been
    // realigned. Idempotent, so it was never wrong, but it rewrote every
    // worktree row and rebuilt an index to find that out.
    if (owns && storedPathPlatform(db) === platform) {
      db.exec('COMMIT');
      return false;
    }
    db.exec('DROP TRIGGER IF EXISTS worktrees_path_is_immutable');
    db.exec('DROP INDEX IF EXISTS worktrees_live_path');
    recanonicaliseWorktreeKeys(db, platform);
    // Before the stamp, so a rewrite that somehow left a duplicate takes the
    // whole transaction down rather than recording that the file is aligned.
    db.exec(WORKTREE_LIVE_PATH_INDEX);
    db.exec(IMMUTABLE_WORKTREE_PATHS);
    db.prepare(
      'INSERT INTO fleet_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(PATH_PLATFORM, platform);
    if (owns) db.exec('COMMIT');
  } catch (err) {
    if (owns) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* connection gone; the original failure is the one that matters */
      }
    }
    throw err;
  }
  return true;
}

function hasFleetMeta(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fleet_meta'").get() !== undefined;
}
