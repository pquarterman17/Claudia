import type { DatabaseSync } from 'node:sqlite';

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
      `Claudia knows: ${named}. Nothing writes those, so the file has been edited by hand. Correct the agent ` +
      'column to claude or codex, or delete those rows, and reopen.',
  );
}
