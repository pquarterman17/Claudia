import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, it } from 'vitest';
import { closeFleetDb, openFleetDb } from '../src/store/db.js';
import { applyMigrations, MIGRATIONS, schemaVersion } from '../src/store/migrations.js';

const OUT = '/tmp/claude-0/-home-user-Claudia/f710a39b-ff44-5242-b483-a08a3904597f/scratchpad/out3.txt';
writeFileSync(OUT, '');
function LOG(...a: unknown[]) { appendFileSync(OUT, a.map(String).join(' ') + '\n'); }

const dir = mkdtempSync(join(tmpdir(), 'zz-audit-3-'));
const opened: DatabaseSync[] = [];
afterAll(() => { for (const db of opened) closeFleetDb(db); rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function at(version: number): DatabaseSync {
  const r = openFleetDb(join(dir, `db-${n++}`, 'fleet.db'), MIGRATIONS.filter((m) => m.version <= version));
  if (!r.ok) throw new Error(r.message);
  opened.push(r.value);
  return r.value;
}

describe('AUDIT 3: the clamping SQL', () => {
  it('reports what a v2 file even accepts, then what v3 lands', () => {
    const db = at(2);
    LOG('version before =', schemaVersion(db));
    const cases: [string, string, string][] = [
      ['negative', '-5', '-7'],
      ['zero', '0', '0'],
      ['one-under', '29', '0'],
      ['at-min', '30', '1'],
      ['normal', '60', '4'],
      ['at-max', '14400', '12'],
      ['one-over', '14401', '13'],
      ['huge', '999999999', '1000000'],
      ['maxint', '9223372036854775807', '9223372036854775807'],
      ['minint', '-9223372036854775808', '-9223372036854775808'],
    ];
    for (const [label, pulse, kids] of cases) {
      try {
        db.exec(`INSERT INTO missions (id,name,body,status,watch,pulse_sec,max_children,cwd,created_at,updated_at)
                 VALUES ('${label}','${label}','b','active','watching',${pulse},${kids},'/repo',1,1)`);
        LOG(`  v2 ACCEPTED ${label}: pulse=${pulse} kids=${kids}`);
      } catch (e) { LOG(`  v2 refused  ${label}: ${(e as Error).message}`); }
    }
    // Things a STRICT table may or may not take.
    for (const [label, expr] of [['text-number', "'60'"], ['real-whole', '60.0'], ['real-frac', '60.5'], ['null', 'NULL'], ['blob', "x'3630'"]] as [string,string][]) {
      try {
        db.exec(`INSERT INTO missions (id,name,body,status,watch,pulse_sec,max_children,cwd,created_at,updated_at)
                 VALUES ('odd-${label}','odd','b','active','watching',${expr},4,'/repo',1,1)`);
        const got = db.prepare('SELECT pulse_sec, typeof(pulse_sec) AS t FROM missions WHERE id = ?').get(`odd-${label}`);
        LOG(`  v2 ACCEPTED odd/${label}: stored ${JSON.stringify(got)}`);
      } catch (e) { LOG(`  v2 refused  odd/${label}: ${(e as Error).message}`); }
    }

    const beforeCount = db.prepare('SELECT COUNT(*) AS n FROM missions').get()?.['n'];
    LOG('rows before migrate =', beforeCount);

    applyMigrations(db);
    LOG('version after =', schemaVersion(db));
    LOG('rows after    =', db.prepare('SELECT COUNT(*) AS n FROM missions').get()?.['n']);
    for (const row of db.prepare('SELECT id, pulse_sec, max_children, typeof(pulse_sec) AS tp, typeof(max_children) AS tk FROM missions ORDER BY id').all()) {
      LOG('   landed:', JSON.stringify(row));
    }
  });

  it('checks max()/min() with two arguments is scalar, not aggregate', () => {
    const db = at(2);
    LOG('scalar check:', JSON.stringify(db.prepare('SELECT MAX(30, MIN(14400, 5)) AS a, MAX(30, MIN(14400, NULL)) AS b, MAX(1, MIN(12, NULL)) AS c').get()));
  });
});
