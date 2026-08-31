import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { closeFleetDb, openFleetDb } from '../src/store/db.js';
import { applyMigrations, MIGRATIONS } from '../src/store/migrations.js';

const OUT = '/tmp/claude-0/-home-user-Claudia/f710a39b-ff44-5242-b483-a08a3904597f/scratchpad/out2.txt';
writeFileSync(OUT, '');
function LOG(...a: unknown[]) { appendFileSync(OUT, a.map(String).join(' ') + '\n'); }

const dir = mkdtempSync(join(tmpdir(), 'zz-audit-2-'));
const opened: DatabaseSync[] = [];
afterAll(() => { for (const db of opened) closeFleetDb(db); rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function at(version: number): DatabaseSync {
  const r = openFleetDb(join(dir, `db-${n++}`, 'fleet.db'), MIGRATIONS.filter((m) => m.version <= version));
  if (!r.ok) throw new Error(r.message);
  opened.push(r.value);
  return r.value;
}

function seed(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO missions (id,name,body,status,watch,pulse_sec,max_children,cwd,created_at,updated_at)
      VALUES ('m1','M','b','active','watching',60,4,'/repo',1,1);
    INSERT INTO tasks (id,mission_id,title,description,cwd,status,priority,depends_on,acceptance,created_at,updated_at)
      VALUES ('t1','m1','T','d','/repo','running',0,'[]','',1,1);
    INSERT INTO worktrees (id,repo,path,branch,base_sha,owner_mission_id,owner_task_id,state,dirty,last_seen_at,created_at)
      VALUES ('w1','/repo','/wt/a','br','sha','m1','t1','active',0,1,1);
    INSERT INTO child_runs (id,mission_id,task_id,worktree_id,agent,attempt,state,started_at)
      VALUES ('r1','m1','t1','w1','codex',1,'running',1);
    INSERT INTO escalations (id,mission_id,task_id,run_id,source,request,reason,severity,resolution,created_at,resolution_note)
      VALUES ('e1','m1','t1','r1','human','push','because','blocking','approved',1,'approved by paige');
  `);
}

function tryExec(db: DatabaseSync, label: string, sql: string): void {
  try { db.exec(sql); LOG(`  ACCEPTED  ${label}`); }
  catch (e) { LOG(`  refused   ${label}  ->  ${(e as Error).message}`); }
}

describe('AUDIT 2: constraints after the v1 -> v4 rebuild', () => {
  it('still enforces foreign keys against the NEW missions/child_runs tables', () => {
    const db = at(1);
    seed(db);
    applyMigrations(db);
    LOG('== after migrating a v1 file with data ==');
    LOG('foreign_keys pragma =', JSON.stringify(db.prepare('PRAGMA foreign_keys').get()));

    LOG('-- child rows pointing at a mission that does not exist --');
    tryExec(db, 'tasks.mission_id = ghost', `INSERT INTO tasks (id,mission_id,title,description,cwd,status,priority,depends_on,acceptance,created_at,updated_at) VALUES ('tX','ghost','T','d','/r','proposed',0,'[]','',1,1)`);
    tryExec(db, 'child_runs.mission_id = ghost', `INSERT INTO child_runs (id,mission_id,task_id,agent,attempt,state,started_at) VALUES ('rX','ghost','t1','codex',9,'running',1)`);
    tryExec(db, 'child_runs.task_id = ghost', `INSERT INTO child_runs (id,mission_id,task_id,agent,attempt,state,started_at) VALUES ('rY','m1','ghost','codex',9,'running',1)`);
    tryExec(db, 'child_runs.worktree_id = ghost', `INSERT INTO child_runs (id,mission_id,task_id,worktree_id,agent,attempt,state,started_at) VALUES ('rZ','m1','t1','ghost','codex',9,'running',1)`);
    tryExec(db, 'worktrees.owner_mission_id = ghost', `INSERT INTO worktrees (id,repo,path,branch,base_sha,owner_mission_id,state,dirty,last_seen_at,created_at) VALUES ('wX','/r','/wt/x','b','s','ghost','active',0,1,1)`);
    tryExec(db, 'escalations.mission_id = ghost (FKs removed at v4)', `INSERT INTO escalations (id,mission_id,source,request,reason,severity,resolution,created_at) VALUES ('eX','ghost','human','p','r','info','pending',1)`);

    LOG('-- CHECK constraints added at v3 --');
    tryExec(db, "child_runs.agent = 'gemini'", `INSERT INTO child_runs (id,mission_id,task_id,agent,attempt,state,started_at) VALUES ('rG','m1','t1','gemini',8,'running',1)`);
    tryExec(db, 'UPDATE child_runs SET agent = gemini', `UPDATE child_runs SET agent='gemini' WHERE id='r1'`);
    tryExec(db, 'missions.pulse_sec = 0', `UPDATE missions SET pulse_sec=0 WHERE id='m1'`);
    tryExec(db, 'missions.max_children = 9999', `UPDATE missions SET max_children=9999 WHERE id='m1'`);

    LOG('-- unique indexes --');
    tryExec(db, 'duplicate (task_id, attempt)', `INSERT INTO child_runs (id,mission_id,task_id,agent,attempt,state,started_at) VALUES ('rD','m1','t1','codex',1,'running',1)`);
    tryExec(db, 'duplicate live worktree path', `INSERT INTO worktrees (id,repo,path,branch,base_sha,state,dirty,last_seen_at,created_at) VALUES ('wD','/r','/wt/a','b','s','active',0,1,1)`);
    tryExec(db, 'removed worktree on the same path (should be allowed)', `INSERT INTO worktrees (id,repo,path,branch,base_sha,state,dirty,last_seen_at,created_at) VALUES ('wR','/r','/wt/a','b','s','removed',0,1,1)`);
    db.exec(`UPDATE escalations SET idempotency_key='K' WHERE id='e1'`);
    tryExec(db, 'duplicate escalation idempotency_key', `INSERT INTO escalations (id,mission_id,source,request,reason,severity,resolution,created_at,idempotency_key) VALUES ('e2','m1','human','p','r','info','pending',1,'K')`);
    tryExec(db, 'two NULL idempotency_keys (should be allowed)', `INSERT INTO escalations (id,mission_id,source,request,reason,severity,resolution,created_at) VALUES ('e3','m1','human','p','r','info','pending',1)`);
  });

  it('cascades on DELETE FROM missions the way v4 intends', () => {
    const db = at(1);
    seed(db);
    applyMigrations(db);
    LOG('== DELETE FROM missions after v4 ==');
    const count = (t: string) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.['n']);
    LOG('before:', JSON.stringify({ missions: count('missions'), tasks: count('tasks'), runs: count('child_runs'), worktrees: count('worktrees'), escalations: count('escalations') }));
    db.exec("DELETE FROM missions WHERE id='m1'");
    LOG('after :', JSON.stringify({ missions: count('missions'), tasks: count('tasks'), runs: count('child_runs'), worktrees: count('worktrees'), escalations: count('escalations') }));
    LOG('surviving escalation:', JSON.stringify(db.prepare('SELECT * FROM escalations').all()));
    LOG('surviving worktree  :', JSON.stringify(db.prepare('SELECT id, owner_mission_id, owner_task_id FROM worktrees').all()));
  });
});
