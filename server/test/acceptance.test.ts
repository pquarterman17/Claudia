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
  descendsFromBase: true,
  tests: [{ command: 'npm test', exitCode: 0 }],
};

/** A clean, merged worktree — every fact positively observed. */
const SETTLED = { dirty: false, merged: true };

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
      'base commit',
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
      { branch: 'b', baseSha: 'a', headSha: 'c', filesChanged: 1, descendsFromBase: true },
      { autoAcceptWhenGreen: true, allowMissingTests: true },
    );
    expect(verdict.kind).toBe('accept');
  });

  it('will not accept work that does not build on its base', () => {
    // A green test run over a diff that does not descend from the recorded
    // base is evidence about some other tree.
    const verdict = judge({ ...GREEN, descendsFromBase: false }, { ...DEFAULT_ACCEPTANCE, autoAcceptWhenGreen: true });
    expect(verdict.kind).toBe('reject');
  });

  it('asks rather than assumes when ancestry was never checked', () => {
    const evidence = { ...GREEN };
    delete evidence.descendsFromBase;
    const verdict = judge(evidence, { ...DEFAULT_ACCEPTANCE, autoAcceptWhenGreen: true });
    expect(verdict).toMatchObject({ kind: 'needs_human', missing: ['ancestry'] });
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
    expect(blocksCleanup(false, GREEN, SETTLED)).toBe('the task has not been accepted');
  });

  it('refuses when cleanliness was never observed', () => {
    // Found in review: an unknown used to read as permission to delete.
    expect(blocksCleanup(true, GREEN, { merged: true })).toBe('cannot confirm it is clean');
  });

  it('refuses when the merge state was never observed', () => {
    const reason = blocksCleanup(true, GREEN, { dirty: false });
    expect(reason).toContain('cannot confirm');
  });

  it('refuses while the branch is merged nowhere', () => {
    const reason = blocksCleanup(true, GREEN, { dirty: false, merged: false });
    expect(reason).toContain('not merged');
  });

  it('lets a merged pull request fill an unknown merge state', () => {
    expect(blocksCleanup(true, { ...GREEN, prState: 'merged' }, { dirty: false })).toBeUndefined();
  });

  it('does not let a merged pull request overrule git saying otherwise', () => {
    // This test previously asserted the opposite, and was wrong. `prState` is
    // a snapshot: the PR merged, then the child pushed three more commits to
    // the same branch. Git is the authority on whether those commits are
    // anywhere else, and it said no.
    const reason = blocksCleanup(true, { ...GREEN, prState: 'merged' }, { dirty: false, merged: false });
    expect(reason).toContain('not merged');
  });

  it('refuses while the evidence is incomplete', () => {
    const reason = blocksCleanup(true, { branch: 'b', headSha: 'c', filesChanged: 1 }, SETTLED);
    expect(reason).toContain('no test results');
  });

  it('judges cleanup under the policy the acceptance was made under', () => {
    // Found in review: this recomputed with the default policy, so a task
    // accepted under `allowMissingTests` became permanently uncleanable —
    // accepted and undeletable at once, with nothing the human could do.
    const lenient = { autoAcceptWhenGreen: true, allowMissingTests: true };
    const evidence = { branch: 'b', baseSha: 'a', headSha: 'c', filesChanged: 1, descendsFromBase: true };
    expect(judge(evidence, lenient).kind).toBe('accept');
    expect(blocksCleanup(true, evidence, SETTLED, lenient)).toBeUndefined();
    // And the default policy still refuses it, which is why passing it matters.
    expect(blocksCleanup(true, evidence, SETTLED)).toContain('no test results');
  });

  it('allows cleanup of accepted, merged, clean, fully evidenced work', () => {
    expect(blocksCleanup(true, GREEN, SETTLED)).toBeUndefined();
  });
});

describe('evidence that is present but impossible', () => {
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects filesChanged: %s', (filesChanged) => {
    // Found in review: only zero was rejected, so every other impossible
    // number passed. Whatever produced it is broken, and treating its output
    // as authority is worse than having no evidence at all.
    const verdict = judge({ ...GREEN, filesChanged }, { ...DEFAULT_ACCEPTANCE, autoAcceptWhenGreen: true });
    expect(verdict.kind).toBe('reject');
  });

  it('rejects a test result with no command', () => {
    const verdict = judge({ ...GREEN, tests: [{ command: '   ', exitCode: 0 }] });
    expect(verdict).toMatchObject({ kind: 'reject', reason: 'a test result has no command' });
  });

  it('rejects a non-integer exit code', () => {
    const verdict = judge({ ...GREEN, tests: [{ command: 'npm test', exitCode: Number.NaN }] });
    expect(verdict.kind).toBe('reject');
  });

  it('treats nonsense as disqualifying, not as a near miss to be weighed', () => {
    // Even with everything else green and a lenient policy.
    const verdict = judge({ ...GREEN, filesChanged: -5 }, { autoAcceptWhenGreen: true, allowMissingTests: true });
    expect(verdict.kind).toBe('reject');
  });

  it('blocks cleanup on the same nonsense', () => {
    expect(blocksCleanup(true, { ...GREEN, filesChanged: -1 }, SETTLED)).toContain('not a number of files');
  });

  it('still accepts zero files as a real, damning observation', () => {
    expect(judge({ ...GREEN, filesChanged: 0 })).toMatchObject({ kind: 'reject', reason: 'reported complete but changed no files' });
  });
});

describe('ancestry needs something to descend from', () => {
  it('will not take descendsFromBase on trust with no base recorded', () => {
    // Descending from nothing in particular is not ancestry.
    const evidence = { ...GREEN, descendsFromBase: true };
    delete evidence.baseSha;
    const verdict = judge(evidence, { ...DEFAULT_ACCEPTANCE, autoAcceptWhenGreen: true });
    expect(verdict).toMatchObject({ kind: 'needs_human' });
    expect(verdict.kind === 'needs_human' && verdict.missing).toContain('base commit');
  });

  it('does not demand a base when ancestry checking is switched off', () => {
    const evidence = { branch: 'b', headSha: 'c', filesChanged: 1, tests: [{ command: 't', exitCode: 0 }] };
    const verdict = judge(evidence, { autoAcceptWhenGreen: true, allowMissingTests: false, allowUnverifiedAncestry: true });
    expect(verdict.kind).toBe('accept');
  });
});
