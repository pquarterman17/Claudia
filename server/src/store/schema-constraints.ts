import type { DatabaseSync } from 'node:sqlite';
import { worktreePathKey, type PathPlatform } from '../path-key.js';

/**
 * Versions 3 and 4: the constraints the first schema was missing.
 *
 * Both were found by reproducing them against the shipped file rather than by
 * reading it — every case named below was ACCEPTED and read back as a typed
 * value the fleet would then have acted on.
 */

/**
 * The bounds the schema was missing, and the roster it was missing.
 *
 * `missions` shipped with `pulse_sec` and `max_children` as bare NOT NULL
 * integers. The repository checked them against the contract's constants and
 * the schema checked nothing, so `UPDATE missions SET pulse_sec = 0,
 * max_children = 9999` was accepted and read back as a `Mission` — a
 * reconciler pulsing in a tight loop against a ceiling of nine thousand
 * children. Verified before writing this: both values round-tripped.
 *
 * `child_runs.agent` shipped with no CHECK on the deliberate argument that a
 * roster of harnesses is not a lifecycle and adding one should not need a
 * migration. That argument undervalued what the absence costs: `'gemini'` was
 * accepted by a hand-written INSERT *and by the repository's own `create()`*,
 * and `toRun` cast it to `AgentKind` — a typed lie the dispatcher would then
 * act on. The schema's own stated rule is that the file refuses states the
 * fleet has no meaning for regardless of who is writing, and a harness that
 * does not exist is one of those. A future agent kind costs one more migration;
 * that is the cheaper half of the trade.
 *
 * The literals are frozen here, as every shipped migration must be.
 * `migrations.test.ts` ties them back to the contract's constants, so raising a
 * ceiling fails a test that names this migration rather than silently leaving
 * the schema behind the code.
 */
export const SCHEMA_BOUNDS = `
CREATE TABLE missions_rebuild (
  id            TEXT    PRIMARY KEY,
  name          TEXT    NOT NULL,
  body          TEXT    NOT NULL,
  status        TEXT    NOT NULL CHECK (status IN ('active','completed','archived')),
  watch         TEXT    NOT NULL CHECK (watch IN ('watching','paused')),
  pulse_sec     INTEGER NOT NULL CHECK (pulse_sec BETWEEN 30 AND 14400),
  max_children  INTEGER NOT NULL CHECK (max_children BETWEEN 1 AND 12),
  budget_sec    INTEGER CHECK (budget_sec IS NULL OR budget_sec > 0),
  budget_tokens INTEGER CHECK (budget_tokens IS NULL OR budget_tokens > 0),
  cwd           TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;

-- Clamped rather than refused. A file holding pulse_sec = 0 predates the
-- constraint, and the alternative to clamping is a database that can never be
-- opened again with no repair path — which is a worse answer than moving a
-- value the fleet already refuses to create into the range it already
-- enforces. Only nonsense moves; anything the repository could have written
-- passes through untouched.
INSERT INTO missions_rebuild
  SELECT id, name, body, status, watch,
         MAX(30, MIN(14400, pulse_sec)),
         MAX(1, MIN(12, max_children)),
         budget_sec, budget_tokens, cwd, created_at, updated_at
    FROM missions;

DROP TABLE missions;
ALTER TABLE missions_rebuild RENAME TO missions;

CREATE TABLE child_runs_rebuild (
  id               TEXT    PRIMARY KEY,
  mission_id       TEXT    NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id          TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id       TEXT,
  worktree_id      TEXT    REFERENCES worktrees(id) ON DELETE SET NULL,
  agent            TEXT    NOT NULL CHECK (agent IN ('claude','codex')),
  attempt          INTEGER NOT NULL CHECK (attempt >= 1),
  state            TEXT    NOT NULL CHECK (state IN
                     ('dispatched','running','reported','stopped','failed')),
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  terminal_reason  TEXT
) STRICT;

INSERT INTO child_runs_rebuild SELECT * FROM child_runs;

DROP TABLE child_runs;
ALTER TABLE child_runs_rebuild RENAME TO child_runs;

CREATE UNIQUE INDEX child_runs_attempt ON child_runs (task_id, attempt);
CREATE INDEX child_runs_by_mission ON child_runs (mission_id, started_at);
`;

/**
 * The audit trail stops being deleted along with what it describes.
 *
 * `escalations` shipped with `mission_id ... ON DELETE CASCADE` and `task_id` /
 * `run_id` as `ON DELETE SET NULL`. That makes a human's decision — approved,
 * by whom, with what note — collateral damage of deleting the mission it was
 * about, and it was measured: an escalation resolved `approved` with a note
 * came back `undefined` after one `DELETE FROM missions`. The SET NULL half is
 * the same loss more quietly, erasing which run a push was approved for while
 * leaving the approval standing.
 *
 * `fleet_events` already made this call and says why in its own comment: a
 * cascade erases the history of exactly the deletion someone later wants
 * explained. An escalation is that, plus a person's name against it. So it
 * loses its foreign keys entirely and keeps its ids as plain text, exactly as
 * the event log does.
 *
 * The line this draws: deleting a mission may take its OPERATIONAL rows —
 * tasks, runs, worktrees are state, and state belongs to the thing that owns
 * it. What survives is the record of what happened and who agreed to it.
 */
export const DURABLE_ESCALATIONS = `
CREATE TABLE escalations_rebuild (
  id               TEXT    PRIMARY KEY,
  -- Deliberately NOT foreign keys; see above. An escalation outlives the
  -- mission, task and run it names.
  mission_id       TEXT    NOT NULL,
  task_id          TEXT,
  run_id           TEXT,
  source           TEXT    NOT NULL CHECK (source IN ('human','manager','child','system')),
  request          TEXT    NOT NULL,
  reason           TEXT    NOT NULL,
  severity         TEXT    NOT NULL CHECK (severity IN ('info','warning','blocking')),
  resolution       TEXT    NOT NULL CHECK (resolution IN
                     ('pending','approved','denied','expired','withdrawn')),
  expires_at       INTEGER,
  created_at       INTEGER NOT NULL,
  resolved_at      INTEGER,
  resolution_note  TEXT,
  idempotency_key  TEXT
) STRICT;

INSERT INTO escalations_rebuild
  SELECT id, mission_id, task_id, run_id, source, request, reason, severity,
         resolution, expires_at, created_at, resolved_at, resolution_note,
         idempotency_key
    FROM escalations;

DROP TABLE escalations;
ALTER TABLE escalations_rebuild RENAME TO escalations;

CREATE INDEX escalations_by_mission ON escalations (mission_id, resolution, created_at);
CREATE UNIQUE INDEX escalations_key ON escalations (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
`;

/**
 * Refuses the upgrade, by hand, before the CHECK constraint can.
 *
 * A row whose agent is outside the roster cannot be carried forward: there is
 * nothing to clamp it to, and inventing one would misreport which harness did
 * the work. The constraint would refuse it anyway — with "CHECK constraint
 * failed: child_runs_rebuild", which names neither the row nor the value nor
 * what to do about it. The migration fails either way; only one of the two
 * failures is answerable.
 */
export function refuseUnknownAgents(db: DatabaseSync): void {
  const rows = db
    .prepare("SELECT id, agent FROM child_runs WHERE agent NOT IN ('claude','codex') LIMIT 5")
    .all() as { id: string; agent: string }[];
  if (rows.length === 0) return;
  const named = rows.map((row) => `${row.id} (agent ${JSON.stringify(row.agent)})`).join(', ');
  throw new Error(
    `child_runs holds ${rows.length === 5 ? 'at least 5' : String(rows.length)} run(s) whose agent is not a harness ` +
      `Claudia knows: ${named}. Builds before this one accepted any string here, through the repository as well ` +
      'as by hand, so this need not be an edited file. Nothing can guess which harness did the work, so it cannot ' +
      "be carried forward: run  UPDATE child_runs SET agent='claude' WHERE agent NOT IN ('claude','codex');  " +
      'against the file (or delete those rows) and reopen.',
  );
}

/**
 * One live claim per DIRECTORY, not per spelling of one.
 *
 * `worktrees_live_path` was unique on the raw `path` text while `samePath`
 * folded case and separators, so `C:\\Repo\\Work` and `c:/repo/work` were one
 * directory to the policy that decides who may write there and two rows to the
 * index that makes ownership provable. Measured before this was written: both
 * inserts succeeded, two live claims, two owners, one checkout on disk.
 *
 * The key is stored rather than computed in the query so the uniqueness is the
 * database's, not a convention every caller has to remember. `path` keeps
 * whatever the caller wrote, because that is what a human reads and what gets
 * handed to `cd`.
 */
export const CANONICAL_WORKTREE_PATHS = `
CREATE TABLE worktrees_rebuild (
  id                TEXT    PRIMARY KEY,
  repo              TEXT    NOT NULL,
  path              TEXT    NOT NULL,
  -- The same directory, spelled one way. Written by the repository from
  -- worktreePathKey, so policy and storage cannot drift apart.
  path_key          TEXT    NOT NULL,
  branch            TEXT    NOT NULL,
  base_sha          TEXT    NOT NULL,
  owner_mission_id  TEXT    REFERENCES missions(id) ON DELETE SET NULL,
  owner_task_id     TEXT    REFERENCES tasks(id) ON DELETE SET NULL,
  state             TEXT    NOT NULL CHECK (state IN ('active','idle','stale','archived','removed')),
  dirty             INTEGER NOT NULL CHECK (dirty IN (0,1)),
  last_seen_at      INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
) STRICT;

INSERT INTO worktrees_rebuild
  SELECT id, repo, path, path, branch, base_sha, owner_mission_id, owner_task_id,
         state, dirty, last_seen_at, created_at
    FROM worktrees;

DROP TABLE worktrees;
ALTER TABLE worktrees_rebuild RENAME TO worktrees;
`;

/**
 * Fills in the key, and settles any duplication the old index allowed.
 *
 * Done here rather than in SQL because the canonical form is `node:path`'s,
 * not something to re-implement in SQLite string functions and keep in step.
 *
 * Rows that collapse onto one key are the old bug's output, not two real
 * claims: the newest keeps the directory and the rest are marked `removed`,
 * which is what they always were in fact. Refusing instead would make a file
 * unopenable over damage this schema itself permitted — the hazard the
 * clamping decision above was taken to avoid.
 */
export function canonicaliseWorktreePaths(db: DatabaseSync, platform: PathPlatform): void {
  recanonicaliseWorktreeKeys(db, platform);
  db.exec(WORKTREE_LIVE_PATH_INDEX);
}

/** The index that turns "one key per directory" into something the file enforces. */
export const WORKTREE_LIVE_PATH_INDEX = `CREATE UNIQUE INDEX worktrees_live_path ON worktrees (path_key) WHERE state <> 'removed'`;

/**
 * Rewrites every key under `platform`, retiring rows that collapse onto one.
 *
 * Split out from the migration above so the platform-realignment on open can
 * reuse the rewrite. The caller handles the index: migration 5 creates it
 * afterwards because it does not exist yet, and the realignment drops it first
 * because an intermediate state mid-rewrite can hold a duplicate the finished
 * state does not.
 *
 * Newest-wins, and the losers are marked `removed` rather than deleted: they
 * are still history, and `removed` is the one state the live index exempts.
 * That retirement is migration 5's decision and only migration 5's — its
 * duplicates are ONE directory recorded twice by an index that compared raw
 * text, so nothing real is lost. The realignment refuses before it gets here
 * (see `alignPathPlatform`), because its duplicates are two directories that
 * genuinely existed and each held a claim.
 */
export function recanonicaliseWorktreeKeys(db: DatabaseSync, platform: PathPlatform): void {
  const rows = db
    .prepare('SELECT id, path, state, created_at FROM worktrees ORDER BY created_at DESC, id DESC')
    .all() as { id: string; path: string; state: string; created_at: number }[];
  const setKey = db.prepare('UPDATE worktrees SET path_key = ? WHERE id = ?');
  const retire = db.prepare("UPDATE worktrees SET state = 'removed' WHERE id = ?");
  const claimed = new Set<string>();
  for (const row of rows) {
    const key = worktreePathKey(row.path, platform);
    setKey.run(key, row.id);
    if (row.state === 'removed') continue;
    if (claimed.has(key)) retire.run(row.id);
    else claimed.add(key);
  }
}

/**
 * A worktree's path stops being editable, so its key cannot drift from it.
 *
 * `path` and `path_key` were two independent writable columns, and the
 * uniqueness guarantee lives entirely on the second. Found in review, through
 * the deliberately exposed connection: updating `path` from `/a` to `/b` and
 * leaving the key behind made `byPath('/b')` miss the row, made `byPath('/a')`
 * return a record whose path is `/b`, and let a SECOND live `/b` row be
 * written. The index still held; it was simply no longer about the directory.
 *
 * Immutability is the answer rather than a paired-update rule, because there is
 * no such thing as moving a worktree here: a different path is a different
 * checkout, with a different branch and a different owner. Nothing in the
 * repository updates either column, so this forbids only what was never meant
 * to happen — and it is the database that forbids it, which is the point, since
 * the caller doing it is the one holding the raw connection.
 *
 * INSERT is migration 7's half: this trigger only sees UPDATEs. What this
 * closes is drift AFTER the row is written.
 */
export const IMMUTABLE_WORKTREE_PATHS = `
CREATE TRIGGER worktrees_path_is_immutable
BEFORE UPDATE OF path, path_key ON worktrees
FOR EACH ROW WHEN NEW.path IS NOT OLD.path OR NEW.path_key IS NOT OLD.path_key
BEGIN
  SELECT RAISE(ABORT, 'a worktree path cannot be changed; record a new worktree instead');
END;
`;

/**
 * The database derives the key itself, so an insert cannot disagree with it.
 *
 * Migration 6 stopped the columns drifting AFTER a row exists. This closes the
 * other half a review found: through the exposed connection, an INSERT could
 * still write `path='/a', path_key='/b'`, and the row would then be owned at
 * one directory while claiming to be at another.
 *
 * The trigger calls `claudia_path_key`, which `openFleetDb` registers as a
 * deterministic SQLite function backed by the SAME canonicaliser the
 * repository uses. That is the point: one implementation, checked by the
 * database, rather than a second one written in SQL string functions that
 * would have to be kept in step with the first.
 *
 * The cost is honest and worth stating: a connection that has not registered
 * the function cannot insert worktrees. That is the sqlite3 CLI and anything
 * else outside this process, which is exactly the writer this is defending
 * against.
 *
 * Two things a later migration has to know. The `typeof` guard is there so a
 * missing path is answered by its own NOT NULL constraint rather than by a
 * message about canonical forms — everything else STRICT will have converted
 * to text before this runs. And the key a row carries is the canonical form
 * for the HOST that wrote it, so a table rebuild copying worktrees forward
 * must drop this trigger for the copy: a file written on Windows and rebuilt
 * on Linux would otherwise abort the migration on rows that were never wrong.
 */
export const DERIVED_WORKTREE_KEYS = `
CREATE TRIGGER worktrees_path_key_is_derived
BEFORE INSERT ON worktrees
FOR EACH ROW WHEN typeof(NEW.path) = 'text' AND NEW.path_key IS NOT claudia_path_key(NEW.path)
BEGIN
  SELECT RAISE(ABORT, 'a worktree path_key must be the canonical form of its path');
END;
`;
