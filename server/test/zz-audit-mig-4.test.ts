import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, it } from 'vitest';
import { closeFleetDb, openFleetDb } from '../src/store/db.js';
import { applyMigrations, latestVersion, MIGRATIONS, schemaVersion, type Migration } from '../src/store/migrations.js';

const OUT = '/tmp/claude-0/-home-user-Claudia/f710a39b-ff44-5242-b483-a08a3904597f/scratchpad/out4.txt';
writeFileSync(OUT, '');
function LOG(...a: unknown[]) { appendFileSync(OUT, a.map(String).join(' ') + '\n'); }

const dir = mkdtempSync(join(tmpdir(), 'zz-audit-4-'));
const opened: DatabaseSync[] = [];
afterAll(() => { for (const db of opened) closeFleetDb(db); rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function path(): string { return join(dir, `db-${n++}`, 'fleet.db'); }
function at(p: string, version: number): DatabaseSync {
  const r = openFleetDb(p, MIGRATIONS.filter((m) => m.version <= version));
  if (!r.ok) throw new Error(r.message);
  opened.push(r.value);
  return r.value;
}
const fk = (db: DatabaseSync) => db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys'];

describe('AUDIT 4: the PRAGMA foreign_keys dance', () => {
  it('applyMigrations called while the caller already holds a transaction', () => {
    const p = path();
    const db = at(p, 2);
    db.exec('BEGIN');
    LOG('inside a caller BEGIN: isTransaction=', db.isTransaction, 'fk=', fk(db));
    try { applyMigrations(db); LOG('  applyMigrations RETURNED (no throw)'); }
    catch (e) { LOG('  applyMigrations threw:', (e as Error).message); }
    LOG('  after: isTransaction=', db.isTransaction, 'fk=', fk(db), 'version=', schemaVersion(db));
    try { db.exec('ROLLBACK'); } catch (e) { LOG('  rollback:', (e as Error).message); }
    LOG('  post-rollback: fk=', fk(db), 'version=', schemaVersion(db));
    // Can the file still be opened normally afterwards?
    const again = openFleetDb(p);
    LOG('  reopen after that mess:', again.ok ? 'ok, version ' + schemaVersion(again.value) : 'FAILED ' + again.message);
    if (again.ok) opened.push(again.value);
  });

  it('applyMigrations on a connection where foreign keys were already OFF', () => {
    const p = path();
    const db = at(p, 2);
    db.exec('PRAGMA foreign_keys = OFF');
    LOG('fk before =', fk(db));
    // A run row whose mission does not exist: only possible with enforcement off.
    db.exec(`INSERT INTO missions (id,name,body,status,watch,pulse_sec,max_children,cwd,created_at,updated_at) VALUES ('m1','M','b','active','watching',60,4,'/r',1,1);
             INSERT INTO tasks (id,mission_id,title,description,cwd,status,priority,depends_on,acceptance,created_at,updated_at) VALUES ('t1','ghost-mission','T','d','/r','proposed',0,'[]','',1,1);`);
    LOG('orphan task inserted with fk off; rows =', db.prepare('SELECT COUNT(*) AS n FROM tasks').get()?.['n']);
    try { applyMigrations(db); LOG('  applyMigrations returned, version=', schemaVersion(db)); }
    catch (e) { LOG('  applyMigrations threw:', (e as Error).message); }
    LOG('  fk after =', fk(db), ' <-- was it turned back ON when it started OFF?');
    LOG('  version =', schemaVersion(db), 'tasks =', db.prepare('SELECT COUNT(*) AS n FROM tasks').get()?.['n']);
  });

  it('restores enforcement when the version re-read inside the lock makes it skip', () => {
    // Two connections on one file, both at v2, both migrating.
    const p = path();
    const a = at(p, 2);
    const bOpen = openFleetDb(p, MIGRATIONS.filter((m) => m.version <= 2));
    if (!bOpen.ok) throw new Error(bOpen.message);
    const b = bOpen.value; opened.push(b);
    LOG('a version', schemaVersion(a), 'b version', schemaVersion(b), 'a fk', fk(a), 'b fk', fk(b));
    LOG('a applied', applyMigrations(a), '-> version', schemaVersion(a), 'fk', fk(a));
    // b still believes it is at 2 (it sampled before). This is the skip path.
    LOG('b sees version', schemaVersion(b));
    LOG('b applied', applyMigrations(b), '-> version', schemaVersion(b), 'fk', fk(b), '<-- fk must be 1 after the ROLLBACK/continue path');
    // Does b still enforce?
    try { b.exec(`INSERT INTO tasks (id,mission_id,title,description,cwd,status,priority,depends_on,acceptance,created_at,updated_at) VALUES ('tX','ghost','T','d','/r','proposed',0,'[]','',1,1)`); LOG('  b ACCEPTED an orphan task -- enforcement leaked OFF'); }
    catch (e) { LOG('  b refused an orphan task:', (e as Error).message); }
  });

  it('what a busy write lock does to a migrating opener', () => {
    const p = path();
    const holder = at(p, 2);
    holder.exec('BEGIN IMMEDIATE');
    holder.exec(`INSERT INTO missions (id,name,body,status,watch,pulse_sec,max_children,cwd,created_at,updated_at) VALUES ('mh','M','b','active','watching',60,4,'/r',1,1)`);
    const started = Date.now();
    const other = openFleetDb(p);
    LOG('open while another connection holds the write lock:', other.ok ? 'ok' : 'FAILED', 'after', Date.now() - started, 'ms');
    if (!other.ok) LOG('   message:', other.message);
    if (other.ok) opened.push(other.value);
    holder.exec('ROLLBACK');
  });

  it('a rebuild whose up() throws leaves fk restored and nothing applied', () => {
    const p = path();
    const db = at(p, latestVersion(MIGRATIONS));
    const doomed: Migration = {
      version: latestVersion(MIGRATIONS) + 1,
      name: 'zz-doomed',
      rebuildsTables: true,
      up: (t) => { t.exec('CREATE TABLE zz (id TEXT)'); throw new Error('boom'); },
    };
    try { applyMigrations(db, [...MIGRATIONS, doomed]); } catch (e) { LOG('threw:', (e as Error).message); }
    LOG('fk after failed rebuild =', fk(db), 'version =', schemaVersion(db), 'isTransaction =', db.isTransaction);
    LOG('zz table present?', db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='zz'").get()?.['n']);
  });

  it('a rebuild whose up() swallows the transaction (COMMITs itself)', () => {
    const p = path();
    const db = at(p, latestVersion(MIGRATIONS));
    const rude: Migration = {
      version: latestVersion(MIGRATIONS) + 1,
      name: 'zz-rude',
      rebuildsTables: true,
      up: (t) => { t.exec('COMMIT'); throw new Error('after committing'); },
    };
    try { applyMigrations(db, [...MIGRATIONS, rude]); } catch (e) { LOG('threw:', (e as Error).message); }
    LOG('fk after =', fk(db), 'isTransaction =', db.isTransaction, 'version =', schemaVersion(db));
  });
});
