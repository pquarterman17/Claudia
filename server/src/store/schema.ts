/**
 * The schema as it was first released: the six durable tables, and the
 * escalation key added a version later.
 *
 * Frozen, both of them — a shipped migration cannot be edited without leaving
 * every database that already ran it in a state no version number describes.
 * Later changes live in schema-constraints.ts.
 *
 * Split from the runner because they are content, not mechanism: this file
 * says what the database looks like, migrations.ts says how a file is brought
 * forward to it.
 */

/**
 * The durable entities of plans/ARGUS_PARITY_PLAN.md, one table each, mirroring
 * the shapes in shared/src/mission.ts.
 *
 * STRICT tables: SQLite otherwise stores whatever it is handed, so a bug that
 * writes a number into `status` would round-trip silently and only surface as a
 * status nothing in the UI can render. STRICT makes that a write error.
 *
 * The CHECK constraints repeat the status unions from the domain contract. That
 * duplication is deliberate: the repositories validate, but the file also
 * outlives this process and may be opened by a future version or a human with a
 * sqlite3 prompt, and the database should refuse a state the fleet has no
 * meaning for regardless of who is writing.
 */
export const FLEET_CORE = `
CREATE TABLE missions (
  id            TEXT    PRIMARY KEY,
  name          TEXT    NOT NULL,
  body          TEXT    NOT NULL,
  status        TEXT    NOT NULL CHECK (status IN ('active','completed','archived')),
  watch         TEXT    NOT NULL CHECK (watch IN ('watching','paused')),
  pulse_sec     INTEGER NOT NULL,
  max_children  INTEGER NOT NULL,
  -- Null means no ceiling. Both are enforced by the dispatcher; the store only
  -- has to make them survive a restart, since a budget forgotten on restart is
  -- a budget that never applied.
  budget_sec    INTEGER CHECK (budget_sec IS NULL OR budget_sec > 0),
  budget_tokens INTEGER CHECK (budget_tokens IS NULL OR budget_tokens > 0),
  cwd           TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;

CREATE TABLE tasks (
  id           TEXT    PRIMARY KEY,
  mission_id   TEXT    NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  title        TEXT    NOT NULL,
  description  TEXT    NOT NULL,
  cwd          TEXT    NOT NULL,
  status       TEXT    NOT NULL CHECK (status IN
                 ('proposed','ready','blocked','running','reported','accepted','failed','cancelled')),
  priority     INTEGER NOT NULL,
  -- A JSON array of task ids. Dependencies are read whole, per task, and never
  -- joined on; a link table would buy nothing and cost a second write path.
  depends_on   TEXT    NOT NULL,
  acceptance   TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
) STRICT;

CREATE INDEX tasks_by_mission ON tasks (mission_id, priority, created_at);

CREATE TABLE worktrees (
  id                TEXT    PRIMARY KEY,
  repo              TEXT    NOT NULL,
  path              TEXT    NOT NULL,
  branch            TEXT    NOT NULL,
  base_sha          TEXT    NOT NULL,
  owner_mission_id  TEXT    REFERENCES missions(id) ON DELETE SET NULL,
  owner_task_id     TEXT    REFERENCES tasks(id) ON DELETE SET NULL,
  state             TEXT    NOT NULL CHECK (state IN ('active','idle','stale','archived','removed')),
  dirty             INTEGER NOT NULL CHECK (dirty IN (0,1)),
  last_seen_at      INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
) STRICT;

-- One live record per directory: two rows claiming the same path would make
-- ownership unprovable, which is exactly what the plan forbids. Removed rows are
-- history and are exempt, so a path can legitimately be claimed again later.
CREATE UNIQUE INDEX worktrees_live_path ON worktrees (path) WHERE state <> 'removed';

CREATE TABLE child_runs (
  id               TEXT    PRIMARY KEY,
  mission_id       TEXT    NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id          TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- Null once the live session has gone; the run record outlives the process.
  session_id       TEXT,
  worktree_id      TEXT    REFERENCES worktrees(id) ON DELETE SET NULL,
  agent            TEXT    NOT NULL,
  attempt          INTEGER NOT NULL CHECK (attempt >= 1),
  state            TEXT    NOT NULL CHECK (state IN
                     ('dispatched','running','reported','stopped','failed')),
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  terminal_reason  TEXT
) STRICT;

-- A retry is a new attempt number, so this is the last line of defence against a
-- repeated pulse dispatching the same attempt twice.
CREATE UNIQUE INDEX child_runs_attempt ON child_runs (task_id, attempt);
CREATE INDEX child_runs_by_mission ON child_runs (mission_id, started_at);

CREATE TABLE escalations (
  id               TEXT    PRIMARY KEY,
  mission_id       TEXT    NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id          TEXT    REFERENCES tasks(id) ON DELETE SET NULL,
  run_id           TEXT    REFERENCES child_runs(id) ON DELETE SET NULL,
  source           TEXT    NOT NULL CHECK (source IN ('human','manager','child','system')),
  request          TEXT    NOT NULL,
  reason           TEXT    NOT NULL,
  severity         TEXT    NOT NULL CHECK (severity IN ('info','warning','blocking')),
  resolution       TEXT    NOT NULL CHECK (resolution IN
                     ('pending','approved','denied','expired','withdrawn')),
  -- Null means the request stands until someone answers it. Without a time to
  -- compare against, the 'expired' resolution is unreachable.
  expires_at       INTEGER,
  created_at       INTEGER NOT NULL,
  resolved_at      INTEGER,
  resolution_note  TEXT
) STRICT;

CREATE INDEX escalations_by_mission ON escalations (mission_id, resolution, created_at);

CREATE TABLE fleet_events (
  -- AUTOINCREMENT, not a plain rowid: plain rowids are reused after the highest
  -- row is deleted, and a browser holding "I have seen up to seq N" must never
  -- be shown a different event numbered N or below.
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Deliberately NOT a foreign key. The log is the audit trail and has to
  -- survive the mission it describes; a cascade here would erase the history of
  -- exactly the deletion someone later wants to explain.
  mission_id       TEXT    NOT NULL,
  -- Denormalised for filtering, and unconstrained for the same reason as
  -- mission_id: an event outlives the task or run it is about.
  task_id          TEXT,
  run_id           TEXT,
  actor            TEXT    NOT NULL CHECK (actor IN ('human','manager','child','system')),
  kind             TEXT    NOT NULL,
  -- JSON text. Read back with JSON.parse and never evaluated.
  payload          TEXT    NOT NULL,
  at               INTEGER NOT NULL,
  -- Optional, but unique when present: this is what makes a repeated pulse a
  -- no-op instead of a second dispatch. SQLite treats NULLs as distinct, so
  -- unkeyed events are unaffected by the constraint.
  idempotency_key  TEXT    UNIQUE
) STRICT;

CREATE INDEX fleet_events_by_mission ON fleet_events (mission_id, seq);
-- Partial, because most events belong to a mission rather than to one task, and
-- an index over all those nulls would cost every append without serving a read.
-- Run-level filtering rides on this one: a run's events are a subset of its
-- task's, and a second index on the append path is not worth that narrowing.
CREATE INDEX fleet_events_by_task ON fleet_events (task_id, seq) WHERE task_id IS NOT NULL;
`;

/**
 * Escalations get an idempotency key, enforced by the database.
 *
 * A watchdog tick that finds a stuck run produces the same escalation every
 * time, and a key returned by a pure helper stops nothing on its own — the
 * repository was generating a fresh UUID per call, so a pulse each minute
 * filed a new inbox row each minute. The uniqueness has to live where the
 * write happens; anything above it is advisory.
 *
 * Added as its own migration rather than amended into `fleet-core`: the point
 * of a version list is that a later change cannot disturb what already ran.
 */
export const ESCALATION_KEYS = `
ALTER TABLE escalations ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX escalations_key ON escalations (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
`;

/**
 * A mission names the agent its children run on.
 *
 * The roster has been two harnesses since Codex landed, and `ChildRun.agent`
 * has always been typed and stored — but nothing chose it. The pulse wrote
 * `'claude'` and the launcher launched `'claude'`, so a repository best served
 * by the other one had no way to say so short of editing two constants and
 * restarting.
 *
 * On the mission rather than on the task, because it is a property of how a
 * body of work should be done rather than of one unit of it, and because a
 * task inheriting a mission's answer needs no column of its own. A task-level
 * override is a later migration if a mixed mission ever turns out to be worth
 * the second place to look.
 *
 * `DEFAULT 'claude'` is what makes this a widening rather than a break: every
 * mission written before this migration ran was launched on Claude, so the
 * default records what already happened instead of guessing. The CHECK is the
 * lesson from `child_runs.agent`, which shipped without one and accepted
 * `'gemini'` from a hand-written UPDATE — a value that cannot be stored is one
 * the reader never has to be strict about.
 */
export const MISSION_AGENT = `
ALTER TABLE missions ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude'
  CHECK (agent IN ('claude','codex'));
`;

/**
 * The command a mission's work is checked with. Migration 10.
 *
 * NULL rather than a default, and the reader treats absent as "nobody checks":
 * every mission written before this column existed had no such command, and
 * inventing one — `npm test`, say — would have the fleet running something in
 * a worktree that its owner never asked for.
 *
 * No CHECK, unlike `agent`. There is no set of legal values to enforce: it is
 * a shell command, and the constraint that matters (a timeout, a bounded
 * output) belongs to the thing that runs it, not to the column that holds it.
 */
export const MISSION_VERIFY = `
ALTER TABLE missions ADD COLUMN verify TEXT;
`;

/**
 * What one attempt spent. Migration 11.
 *
 * NULL rather than 0, and the reader keeps the difference: a run whose count
 * nobody could read is not a run that spent nothing. `overBudget` holds a
 * mission whose spend is unreadable, on the fleet's standing bias that an
 * unknown is not permission — so a zero here would be a lie that reads as
 * headroom.
 */
export const RUN_TOKENS = `
ALTER TABLE child_runs ADD COLUMN tokens INTEGER;
`;

/**
 * The index `latestForTask` actually needs.
 *
 * `fleet_events_by_task` is `(task_id, seq)`, so a lookup filtered by `kind`
 * walks every event the task has until it finds a match. The case that hurts
 * is the NEGATIVE one — `hasJudgement` asking whether a freshly reported run
 * has been judged, on every pulse, and the answer being "no" — which scanned
 * the task's whole partition. Adding `kind` ahead of `seq` makes the walk stop
 * at the first miss instead of at the last row.
 */
export const EVENTS_BY_TASK_KIND = `
CREATE INDEX IF NOT EXISTS fleet_events_by_task_kind
  ON fleet_events (task_id, kind, seq) WHERE task_id IS NOT NULL;
`;

/**
 * Which attempt a reported task's claim belongs to, on the task row.
 *
 * It used to be reconstructed by scanning the log for the newest run-scoped
 * `task_reported`, which meant every writer of the `reported` status had to
 * remember to append one. Three writers existed — the pulse, crash recovery,
 * and `set_task_status` over the wire — and each was found the same way: by a
 * review noticing that acceptance had validated a second attempt against the
 * first one's verdict. A fact every caller must remember is a fact that will
 * be forgotten; `setStatus` writes this one itself, in the transaction that
 * moves the status, so there is nothing to remember.
 *
 * Nullable: a task that has never reported has no attempt under review, and
 * one carried over from before this column reads as unknown rather than as
 * some particular run.
 */
export const TASK_CURRENT_RUN = `
ALTER TABLE tasks ADD COLUMN current_run_id TEXT REFERENCES child_runs (id) ON DELETE SET NULL;

-- Backfilled for tasks already under review, from the same rule setStatus
-- applies: the task's newest attempt, and only if it has reported. Without
-- this, every claim open at the moment of the upgrade loses its scoping and
-- the newest verdict of ANY attempt authorises it — which is the hole this
-- column exists to close, opened by the migration that closes it.
UPDATE tasks
   SET current_run_id = (
     SELECT id FROM child_runs
      WHERE child_runs.task_id = tasks.id AND child_runs.state = 'reported'
      ORDER BY attempt DESC LIMIT 1
   )
 WHERE status = 'reported'
   AND (SELECT state FROM child_runs WHERE child_runs.task_id = tasks.id ORDER BY attempt DESC LIMIT 1) = 'reported';
`;

/**
 * Capability grants, one per run.
 *
 * `capabilities.ts` has been able to grade a request against a grant since the
 * capability work landed, and there was nowhere to keep one: no table, no
 * issuer, no lookup. The module's own argument is that a grant is only ever
 * reached by LOOKING IT UP for a run — "provenance that travels with the thing
 * being checked is not provenance; it is a suggestion" — and a grant with no
 * store cannot be looked up, so nothing checked anything.
 *
 * `run_id` is the primary key rather than an id of its own: the binding is per
 * run by design, and a second grant for the same run is the standing
 * permission the scope rule exists to prevent. `ON DELETE CASCADE` because a
 * grant outliving its run is authority with nothing to bound it.
 *
 * `capabilities` is JSON text rather than a join table. It is a short list
 * read whole, written once and never queried across — a table would buy a
 * query nobody makes and cost a second write on the launch path.
 */
export const RUN_GRANTS = `
CREATE TABLE IF NOT EXISTS grants (
  run_id        TEXT    PRIMARY KEY REFERENCES child_runs (id) ON DELETE CASCADE,
  id            TEXT    NOT NULL,
  mission_id    TEXT    NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  task_id       TEXT    NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  repo          TEXT    NOT NULL,
  worktree_path TEXT    NOT NULL,
  capabilities  TEXT    NOT NULL,
  -- Recorded for the audit trail, never the basis of trust: checkCapability
  -- reads it to REFUSE an untrusted issuer, not to believe a trusted one.
  issued_by     TEXT    NOT NULL,
  -- Null means the grant lasts as long as the run. An elevated capability with
  -- no expiry is refused at check time, so this being null is not a loophole.
  expires_at    INTEGER,
  created_at    INTEGER NOT NULL
) STRICT;
`;
