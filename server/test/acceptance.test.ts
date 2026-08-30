import { describe, expect, it } from 'vitest';
import {
  blocksCleanup,
  DEFAULT_ACCEPTANCE,
  judge,
  missingEvidence,
  type Evidence,
} from '../src/fleet/acceptance.js';

/**
 * The gate between "a child said it is done" and "it is done". Pinned hard in
 * one direction: acceptance must never be reachable from prose alone, because
 * the failure it guards against — a run that explored, ran out of turn and
 * wrote a confident summary — looks exactly like success from the board.
 */

const GREEN: Evidence = {
  branch: 'claudia/task-1',
  baseSha: 'aaa',
  headSha: 'bbb',
  filesChanged: 3,
  tests: [{ command: 'npm test', exitCode: 0 }],
};

describe('judge', () => {
  it('rejects a failing check', () => {
    const verdict = judge({ ...GREEN, tests: [{ command: 'npm test', exitCode: 1 }] });
    expect(verdict.kind).toBe('reject');
    expect(verdict.reason).toContain('npm test');
  });

  it('names every failing check, not just the first', () => {
    const verdict = judge({
      ...GREEN,
      tests: [
        { command: 'lint', exitCode: 2 },
        { command: 'typecheck', exitCode: 1 },
        { command: 'unit', exitCode: 0 },
      ],
    });
    expect(verdict.reason).toContain('lint');
    expect(verdict.reason).toContain('typecheck');
  });

  it('rejects a run that reported success and changed nothing', () => {
    // The commonest silent failure: it explored, ran out of turn, and wrote
    // a summary. Idle is not done.
    const verdict = judge({ ...GREEN, filesChanged: 0 });
    expect(verdict).toMatchObject({ kind: 'reject', reason: 'reported complete but changed no files' });
  });

  it('will not accept on prose alone', () => {
    const verdict = judge({ risks: ['none'], artifacts: ['notes.md'] });
    expect(verdict.kind).toBe('needs_human');
  });

  it('lists everything the evidence is missing at once', () => {
    // One missing field per pulse is how a person stops reading the inbox.
    const verdict = judge({ branch: 'b' });
    expect(verdict.kind === 'needs_human' && verdict.missing).toEqual([
      'head commit',
      'diff summary',
      'test results',
    ]);
  });

  it('separates "I cannot tell" from "this is wrong"', () => {
    // Absent evidence is not a failure, and collapsing the two either hides
    // real failures or cries wolf.
    expect(judge({ branch: 'b', headSha: 'c', filesChanged: 2 }).kind).toBe('needs_human');
    expect(judge({ ...GREEN, tests: [{ command: 'x', exitCode: 1 }] }).kind).toBe('reject');
  });

  it('asks a human even when everything is green, by default', () => {
    // The plan requires an auditable decision, and "nobody looked" is not one.
    const verdict = judge(GREEN);
    expect(verdict).toMatchObject({ kind: 'needs_human', missing: [] });
    expect(verdict.reason).toContain('acceptance is yours');
  });

  it('accepts a green run when the human has said it may', () => {
    const verdict = judge(GREEN, { ...DEFAULT_ACCEPTANCE, autoAcceptWhenGreen: true });
    expect(verdict.kind).toBe('accept');
    expect(verdict.reason).toContain('3 files changed');
  });

  it('still refuses to auto-accept a failing run', () => {
    const verdict = judge(
      { ...GREEN, tests: [{ command: 'x', exitCode: 1 }] },
      { ...DEFAULT_ACCEPTANCE, autoAcceptWhenGreen: true },
    );
    expect(verdict.kind).toBe('reject');
  });

  it('rejects work whose pull request was closed unmerged', () => {
    const verdict = judge({ ...GREEN, prState: 'closed' }, { ...DEFAULT_ACCEPTANCE, autoAcceptWhenGreen: true });
    expect(verdict.kind).toBe('reject');
  });

  it('does not hold a declared risk against the run', () => {
    // A child that admits a risk is behaving better than one that does not.
    const verdict = judge({ ...GREEN, risks: ['no integration test'] }, { ...DEFAULT_ACCEPTANCE, autoAcceptWhenGreen: true });
    expect(verdict.kind).toBe('accept');
  });

  it('can be told tests are not required', () => {
    const verdict = judge(
      { branch: 'b', headSha: 'c', filesChanged: 1 },
      { autoAcceptWhenGreen: true, allowMissingTests: true },
    );
    expect(verdict.kind).toBe('accept');
  });
});

describe('missingEvidence', () => {
  it('finds nothing missing in complete evidence', () => {
    expect(missingEvidence(GREEN)).toEqual([]);
  });

  it('treats an empty test list as no tests', () => {
    expect(missingEvidence({ ...GREEN, tests: [] })).toEqual(['test results']);
  });

  it('accepts zero files changed as a present diff summary', () => {
    // Zero is evidence, and a damning kind; absent is not.
    expect(missingEvidence({ ...GREEN, filesChanged: 0 })).toEqual([]);
  });
});

describe('blocksCleanup', () => {
  it('never removes uncommitted work, accepted or not', () => {
    expect(blocksCleanup(true, GREEN, { dirty: true, merged: true })).toBe('it has uncommitted work');
  });

  it('refuses to clean up a task nobody accepted', () => {
    expect(blocksCleanup(false, GREEN, { merged: true })).toBe('the task has not been accepted');
  });

  it('refuses while the branch is merged nowhere', () => {
    const reason = blocksCleanup(true, GREEN, { merged: false });
    expect(reason).toContain('not merged');
  });

  it('accepts a merged pull request as somewhere', () => {
    expect(blocksCleanup(true, { ...GREEN, prState: 'merged' }, { merged: false })).toBeUndefined();
  });

  it('refuses while the evidence is incomplete', () => {
    const reason = blocksCleanup(true, { branch: 'b', headSha: 'c', filesChanged: 1 }, { merged: true });
    expect(reason).toContain('no test results');
  });

  it('allows cleanup of accepted, merged, clean, fully evidenced work', () => {
    expect(blocksCleanup(true, GREEN, { dirty: false, merged: true })).toBeUndefined();
  });
});
