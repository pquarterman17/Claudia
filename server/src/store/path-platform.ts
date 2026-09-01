import type { DatabaseSync } from 'node:sqlite';
import { HOST_PLATFORM, worktreePathKey, type PathPlatform } from '../path-key.js';
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
 * Refuses rather than choosing, when the new rules merge two live claims. Two
 * directories POSIX keeps apart can be one directory to Windows, and one host
 * cannot honour both claims — but both are REAL. Migration 5 retires its
 * duplicates because they are one directory recorded twice, the output of an
 * index that compared raw text; these are two directories that genuinely
 * existed, each claimed by a different task. Picking a winner by timestamp
 * would discard an ownership record nobody was told about, in the one part of
 * the fleet whose whole job is to know who owns what.
 *
 * So it stops, names the pairs, and says what to do about them. The hazard of
 * an unopenable file is real and the answer to it is the same one migration 3
 * gives for an unknown agent: refuse by hand, with the rows and a repair, since
 * "UNIQUE constraint failed" is not something a person can act on. Nothing is
 * written — the whole realignment is one transaction, and this throws inside
 * it.
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
    refuseMergedClaims(db, platform, storedPathPlatform(db));
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

/**
 * Stops the realignment before it can turn two live claims into one.
 *
 * Read before anything is written, so the message can promise the file is
 * untouched and mean it. Live rows only: a `removed` row holds no claim and the
 * index that enforces this exempts it.
 */
function refuseMergedClaims(db: DatabaseSync, platform: PathPlatform, stored: PathPlatform | undefined): void {
  const rows = db.prepare("SELECT id, path FROM worktrees WHERE state <> 'removed'").all() as {
    id: string;
    path: string;
  }[];
  const byKey = new Map<string, { id: string; path: string }[]>();
  for (const row of rows) {
    const key = worktreePathKey(row.path, platform);
    const together = byKey.get(key) ?? [];
    together.push(row);
    byKey.set(key, together);
  }
  const merged = [...byKey.values()].filter((group) => group.length > 1);
  if (merged.length === 0) return;

  // Id AND path, raw. The id is what the repair below takes, and the path is
  // how a person recognises which checkout it is. Not JSON-quoted: the paths
  // this refusal is ABOUT are the ones with backslashes in them, and printing
  // `/wt/a\\b` for a row that says `/wt/a\b` sends the reader looking for a
  // row that is not there.
  const shown = merged.slice(0, 5).map((group) => group.map((row) => `${row.id} (${row.path})`).join(' and '));
  throw new Error(
    `This fleet.db recorded its worktree paths under ${stored ?? 'unknown'} rules and is being opened under ` +
      `${platform} rules, where ${merged.length === 1 ? 'these two worktrees are' : 'each of these groups is'} ` +
      `the same directory: ${shown.join('; ')}${merged.length > 5 ? `; and ${merged.length - 5} more` : ''}. Each ` +
      'is a live claim held by a task, and one host cannot honour both — so this will not pick one for you. Retire ' +
      "the ones you no longer want with  UPDATE worktrees SET state='removed' WHERE id='<id>';  against the file " +
      'and reopen; the directories and their branches are untouched, and so is this database.',
  );
}

function hasFleetMeta(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fleet_meta'").get() !== undefined;
}
