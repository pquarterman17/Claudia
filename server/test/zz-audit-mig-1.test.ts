import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { appendFileSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
const OUT = '/tmp/claude-0/-home-user-Claudia/f710a39b-ff44-5242-b483-a08a3904597f/scratchpad/out1.txt';
writeFileSync(OUT, '');
function LOG(...a: unknown[]) { appendFileSync(OUT, a.map(String).join(' ') + '\n'); }
import { closeFleetDb, openFleetDb } from '../src/store/db.js';
import { applyMigrations, latestVersion, MIGRATIONS, schemaVersion } from '../src/store/migrations.js';

const dir = mkdtempSync(join(tmpdir(), 'zz-audit-1-'));
const opened: DatabaseSync[] = [];
afterAll(() => {
  for (const db of opened) closeFleetDb(db);
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
function at(version: number): DatabaseSync {
  const path = join(dir, `db-${n++}`, 'fleet.db');
  const r = openFleetDb(path, MIGRATIONS.filter((m) => m.version <= version));
  if (!r.ok) throw new Error(r.message);
  opened.push(r.value);
  return r.value;
}

function master(db: DatabaseSync): { type: string; name: string; tbl: string; sql: string }[] {
  return db
    .prepare("SELECT type, name, tbl_name, COALESCE(sql,'<implicit>') AS sql FROM sqlite_master ORDER BY type, name")
    .all()
    .map((r) => ({
      type: String(r['type']),
      name: String(r['name']),
      tbl: String(r['tbl_name']),
      sql: String(r['sql']).replace(/\s+/g, ' ').trim(),
    }));
}

function seed(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO missions (id, name, body, status, watch, pulse_sec, max_children, budget_sec, budget_tokens, cwd, created_at, updated_at)
      VALUES ('m1','Mission One','body','active','watching',60,4,1000,2000,'/repo',11,12);
    INSERT INTO missions (id, name, body, status, watch, pulse_sec, max_children, cwd, created_at, updated_at)
      VALUES ('m2','Mission Two','b2','completed','paused',90,2,'/repo2',21,22);
    INSERT INTO tasks (id, mission_id, title, description, cwd, status, priority, depends_on, acceptance, created_at, updated_at)
      VALUES ('t1','m1','T1','d','/repo','running',3,'["x"]','acc',31,32);
    INSERT INTO worktrees (id, repo, path, branch, base_sha, owner_mission_id, owner_task_id, state, dirty, last_seen_at, created_at)
      VALUES ('w1','/repo','/wt/a','br','sha','m1','t1','active',1,41,42);
    INSERT INTO worktrees (id, repo, path, branch, base_sha, state, dirty, last_seen_at, created_at)
      VALUES ('w2','/repo','/wt/a','br2','sha2','removed',0,43,44);
    INSERT INTO child_runs (id, mission_id, task_id, session_id, worktree_id, agent, attempt, state, started_at, ended_at, terminal_reason)
      VALUES ('r1','m1','t1','sess-1','w1','codex',1,'failed',51,52,'boom');
    INSERT INTO child_runs (id, mission_id, task_id, agent, attempt, state, started_at)
      VALUES ('r2','m1','t1','claude',2,'running',53);
    INSERT INTO escalations (id, mission_id, task_id, run_id, source, request, reason, severity, resolution, expires_at, created_at, resolved_at, resolution_note)
      VALUES ('e1','m1','t1','r1','human','push','because','blocking','approved',61,62,63,'ok by me');
    INSERT INTO fleet_events (mission_id, task_id, run_id, actor, kind, payload, at, idempotency_key)
      VALUES ('m1','t1','r1','human','dispatch','{}',71,'k1');
  `);
}

describe('AUDIT 1: schema objects across the v1 -> v4 rebuild', () => {
  it('dumps sqlite_master before and after and diffs it', () => {
    const db = at(1);
    seed(db);
    const before = master(db);
    expect(schemaVersion(db)).toBe(1);

    applyMigrations(db);
    expect(schemaVersion(db)).toBe(latestVersion(MIGRATIONS));
    const after = master(db);

    const fmt = (rows: ReturnType<typeof master>) =>
      rows.map((r) => `${r.type} ${r.name} [tbl=${r.tbl}]\n    ${r.sql}`).join('\n');
    LOG('===== BEFORE (v1) =====\n' + fmt(before));
    LOG('===== AFTER (v4) =====\n' + fmt(after));

    const names = (rows: ReturnType<typeof master>) => rows.map((r) => `${r.type}:${r.name}`).sort();
    const lost = names(before).filter((x) => !names(after).includes(x));
    const gained = names(after).filter((x) => !names(before).includes(x));
    LOG('===== LOST =====', JSON.stringify(lost));
    LOG('===== GAINED =====', JSON.stringify(gained));
  });

  it('reports every index that exists at v4, per table', () => {
    const db = at(1);
    seed(db);
    applyMigrations(db);
    for (const t of ['missions', 'tasks', 'worktrees', 'child_runs', 'escalations', 'fleet_events']) {
      const idx = db.prepare(`PRAGMA index_list(${t})`).all();
      LOG(`--- index_list(${t}) ---`, JSON.stringify(idx));
      const fk = db.prepare(`PRAGMA foreign_key_list(${t})`).all();
      LOG(`--- foreign_key_list(${t}) ---`, JSON.stringify(fk));
    }
  });

  it('keeps every row and every column value', () => {
    const db = at(1);
    seed(db);
    const snapshot = (d: DatabaseSync) => ({
      missions: d.prepare('SELECT * FROM missions ORDER BY id').all(),
      tasks: d.prepare('SELECT * FROM tasks ORDER BY id').all(),
      worktrees: d.prepare('SELECT * FROM worktrees ORDER BY id').all(),
      runs: d.prepare('SELECT * FROM child_runs ORDER BY id').all(),
      esc: d.prepare('SELECT * FROM escalations ORDER BY id').all(),
      ev: d.prepare('SELECT * FROM fleet_events ORDER BY seq').all(),
    });
    const before = JSON.parse(JSON.stringify(snapshot(db)));
    applyMigrations(db);
    const after = JSON.parse(JSON.stringify(snapshot(db)));
    LOG('BEFORE rows:', JSON.stringify(before, null, 1));
    LOG('AFTER  rows:', JSON.stringify(after, null, 1));
  });
});
