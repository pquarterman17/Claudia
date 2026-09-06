import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { childReport, REPORT_PATH } from '../src/fleet/child-report.js';

/**
 * The child's own account of what it left unresolved.
 *
 * `risks` and `artifacts` are the two evidence fields that are the child's
 * word rather than an observation, and nothing ever wrote them — so
 * `describeGreen` could not mention a risk and no reviewer ever saw one. Read
 * as untrusted input, because that is exactly what it is: everything bounded,
 * anything malformed dropped rather than repaired.
 */

const dir = mkdtempSync(join(tmpdir(), 'claudia-report-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function worktree(contents?: string): string {
  const path = join(dir, `wt-${counter++}`);
  mkdirSync(join(path, dirname(REPORT_PATH)), { recursive: true });
  if (contents !== undefined) writeFileSync(join(path, REPORT_PATH), contents, 'utf8');
  return path;
}

describe('reading what the child left behind', () => {
  it('takes the risks and artifacts it wrote down', async () => {
    const path = worktree(JSON.stringify({ risks: ['the migration is not reversible'], artifacts: ['docs/plan.md'] }));
    expect(await childReport(path)).toEqual({
      risks: ['the migration is not reversible'],
      artifacts: ['docs/plan.md'],
    });
  });

  it('says nothing when there is no report, which is the common case', async () => {
    // Optional, and a child that skipped it has said nothing rather than
    // nothing good.
    expect(await childReport(worktree())).toEqual({});
    expect(await childReport(join(dir, 'not-a-directory-at-all'))).toEqual({});
  });

  it('drops a malformed report rather than repairing it', async () => {
    // Half-understood self-reporting is worse than none: it reads on the board
    // as though somebody had checked.
    for (const bad of ['not json at all', '[]', 'null', '42', '"a string"']) {
      expect(await childReport(worktree(bad)), bad).toEqual({});
    }
  });

  it('ignores entries that are not text, and lists that are not lists', async () => {
    const path = worktree(JSON.stringify({ risks: ['real', 7, null, '  ', { a: 1 }], artifacts: 'docs/plan.md' }));
    expect(await childReport(path)).toEqual({ risks: ['real'] });
  });

  it('bounds what a child can put in the log', async () => {
    // This text ends up in the event log. A child that writes a thousand risks
    // should cost a truncation, not a database nobody can read.
    const path = worktree(JSON.stringify({ risks: Array.from({ length: 50 }, (_, i) => `risk ${i}`.padEnd(900, '.')) }));
    const read = await childReport(path);
    expect(read.risks).toHaveLength(20);
    for (const risk of read.risks ?? []) expect(risk.length).toBeLessThanOrEqual(301);
  });

  it('refuses a file too large to be a report', async () => {
    expect(await childReport(worktree(JSON.stringify({ risks: ['x'.repeat(200_000)] })))).toEqual({});
  });
});
