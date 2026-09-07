import type { FleetEvent } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import { evidenceSupportsAcceptance, judgementFor } from '../src/judged';

/**
 * Reading a verdict out of an event payload.
 *
 * `FleetEvent.payload` is typed `unknown` on purpose — the log stores JSON and
 * is documented as never being reached into for structure — so every field
 * here is read defensively rather than cast. `null`, `42`, `"done"` and `[]`
 * are all valid JSON, and a component that assumed an object would throw on
 * any of them.
 */

const event = (over: Partial<FleetEvent> & { payload: unknown }): FleetEvent =>
  ({ seq: 1, missionId: 'm1', taskId: 't1', runId: 'r1', actor: 'system', kind: 'task_judged', at: 1, ...over }) as FleetEvent;

const GOOD = {
  verdict: 'needs_human',
  reason: 'no test evidence',
  missing: ['tests'],
  evidence: { branch: 'claudia/x', filesChanged: 3, descendsFromBase: true },
};

describe('finding a verdict', () => {
  it('reads the one for this task', () => {
    const found = judgementFor([event({ payload: GOOD })], 't1');
    expect(found?.verdict).toBe('needs_human');
    expect(found?.missing).toEqual(['tests']);
    expect(found?.filesChanged).toBe(3);
    expect(found?.branch).toBe('claudia/x');
    expect(found?.descendsFromBase).toBe(true);
  });

  it('carries the complete review evidence instead of reducing it to a badge', () => {
    const found = judgementFor([event({ payload: {
      ...GOOD,
      evidence: {
        branch: 'codex/review', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), filesChanged: 4,
        descendsFromBase: true,
        tests: [{ command: 'npm test', exitCode: 0, summary: '201 passed' }],
        prUrl: 'https://github.com/example/repo/pull/12', prState: 'open',
        risks: ['visual regression'], artifacts: ['dist/report.html'],
      },
    } })], 't1');
    expect(found).toMatchObject({
      baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
      tests: [{ command: 'npm test', exitCode: 0, summary: '201 passed' }],
      prUrl: 'https://github.com/example/repo/pull/12', prState: 'open',
      risks: ['visual regression'], artifacts: ['dist/report.html'],
    });
  });

  it('ignores one belonging to another task', () => {
    expect(judgementFor([event({ payload: GOOD, taskId: 't2' })], 't1')).toBeUndefined();
  });

  it('ignores events of another kind', () => {
    expect(judgementFor([event({ payload: GOOD, kind: 'task_reported' })], 't1')).toBeUndefined();
  });

  it('takes the latest, because a task can be reported more than once', () => {
    const found = judgementFor(
      [event({ payload: GOOD }), event({ seq: 2, payload: { ...GOOD, verdict: 'accept', reason: 'all green' } })],
      't1',
    );
    expect(found?.verdict).toBe('accept');
  });

  it('does not show an earlier attempt after a new completion claim arrives', () => {
    const found = judgementFor([
      event({ runId: 'r1', payload: GOOD }),
      event({ seq: 2, runId: 'r2', kind: 'task_reported', payload: { reason: 'the second attempt ended' } }),
    ], 't1');
    expect(found).toBeUndefined();

    const judged = judgementFor([
      event({ runId: 'r1', payload: GOOD }),
      event({ seq: 2, runId: 'r2', kind: 'task_reported', payload: {} }),
      event({ seq: 3, runId: 'r2', payload: { ...GOOD, reason: 'second attempt checked' } }),
    ], 't1');
    expect(judged?.reason).toBe('second attempt checked');
  });

  it('scopes to the current run even when no report note was written', () => {
    // The case the `task_reported` reset could not see. `applyTaskIntent`
    // returns before writing that note when another run still holds the task,
    // and again when the task's route is refused — while `judgeReported`
    // judges every reported run regardless. Run identity is on every event,
    // so the newest one names the attempt whatever branch the pulse took.
    const held = judgementFor([
      event({ runId: 'r1', payload: GOOD }),
      event({ seq: 2, runId: 'r2', kind: 'run_ended_task_held', payload: { reason: 'another run is still active' } }),
    ], 't1');
    expect(held).toBeUndefined();

    const refused = judgementFor([
      event({ runId: 'r1', payload: GOOD }),
      event({ seq: 2, runId: 'r2', kind: 'task_left_as_is', payload: { reason: 'the task is blocked' } }),
    ], 't1');
    expect(refused).toBeUndefined();
  });

  it('keeps a verdict whose run is still the one being talked about', () => {
    const found = judgementFor([
      event({ runId: 'r2', kind: 'task_reported', payload: { reason: 'ended' } }),
      event({ seq: 2, runId: 'r2', payload: GOOD }),
      event({ seq: 3, runId: 'r2', kind: 'escalated', payload: { reason: 'still r2' } }),
    ], 't1');
    expect(found?.verdict).toBe('needs_human');
  });

  it('falls back to the newest verdict on a log that names no runs at all', () => {
    // What a log written before runs were denormalised onto events looks like.
    // Scoping to a run nothing names would hide every verdict in it.
    const legacy = (seq: number, payload: unknown): FleetEvent =>
      ({ seq, missionId: 'm1', taskId: 't1', actor: 'system', kind: 'task_judged', at: 1, payload }) as FleetEvent;
    const found = judgementFor([legacy(1, GOOD), legacy(2, { ...GOOD, verdict: 'accept' })], 't1');
    expect(found?.verdict).toBe('accept');
  });

  it('answers nothing when there is nothing', () => {
    expect(judgementFor(undefined, 't1')).toBeUndefined();
    expect(judgementFor([], 't1')).toBeUndefined();
  });
});

describe('a payload that is not what it should be', () => {
  it('survives every shape valid JSON can take', () => {
    for (const payload of [null, 42, 'done', [], true, undefined]) {
      expect(() => judgementFor([event({ payload })], 't1')).not.toThrow();
      expect(judgementFor([event({ payload })], 't1')).toBeUndefined();
    }
  });

  it('refuses a verdict that is not one of the three', () => {
    expect(judgementFor([event({ payload: { ...GOOD, verdict: 'probably' } })], 't1')).toBeUndefined();
  });

  it('keeps the last good one rather than blanking on a bad one', () => {
    // A malformed payload should not take a verdict off the screen that was
    // read correctly a moment ago.
    const found = judgementFor([event({ payload: GOOD }), event({ seq: 2, payload: 'nonsense' })], 't1');
    expect(found?.verdict).toBe('needs_human');
  });

  it('drops non-string entries out of `missing` rather than rendering them', () => {
    const found = judgementFor([event({ payload: { ...GOOD, missing: ['tests', 7, null] } })], 't1');
    expect(found?.missing).toEqual(['tests']);
  });

  it('carries what the mission\'s own checks said, including when they did not run', () => {
    // `checks` sits outside `evidence` because it also describes the runs that
    // produced none: a command that could not start and one that never
    // finished both leave `tests` absent, and "no test results" alone does not
    // say which — or that anything was attempted at all.
    const ran = judgementFor([event({ payload: { ...GOOD, checks: 'npm test — exit 0' } })], 't1');
    expect(ran?.checks).toBe('npm test — exit 0');

    const missing = judgementFor([event({ payload: GOOD })], 't1');
    expect(missing?.checks).toBeUndefined();

    // Same rule as the evidence fields: the wrong type is absent, never a
    // value the panel renders as though somebody had checked.
    const wrong = judgementFor([event({ payload: { ...GOOD, checks: 7 } })], 't1');
    expect(wrong?.checks).toBeUndefined();
  });

  it('says whether the evidence supports an acceptance', () => {
    // The client's copy of the rule the server enforces, and it exists only so
    // the button can say what it is going to do rather than being refused
    // after the click. `needs_human` is NOT a blocker: it is what a green run
    // gets, because the policy will not accept on nobody's behalf.
    const green = judgementFor([event({ payload: { ...GOOD, verdict: 'needs_human', missing: [] } })], 't1');
    expect(evidenceSupportsAcceptance(green)).toBe(true);

    const holes = judgementFor([event({ payload: { ...GOOD, missing: ['test results'] } })], 't1');
    expect(evidenceSupportsAcceptance(holes)).toBe(false);

    const bad = judgementFor([event({ payload: { ...GOOD, verdict: 'reject', missing: [] } })], 't1');
    expect(evidenceSupportsAcceptance(bad)).toBe(false);

    const unread = judgementFor([event({ payload: {
      ...GOOD,
      missing: [],
      evidence: { tests: [{ command: 'npm test', exitCode: 'unknown' }] },
    } })], 't1');
    expect(unread?.unreadTests).toBe(1);
    expect(evidenceSupportsAcceptance(unread)).toBe(false);

    // Nothing judged at all is the case the old one-click accept was blindest
    // to, so it is the one to be sure of.
    expect(evidenceSupportsAcceptance(undefined)).toBe(false);
  });

  it('treats an evidence field of the wrong type as absent, not as a value', () => {
    // Absent means nobody checked. A `filesChanged` of "lots" must not become
    // a number the panel renders as if somebody had.
    const found = judgementFor([event({ payload: { ...GOOD, evidence: { filesChanged: 'lots', branch: 12 } } })], 't1');
    expect(found?.filesChanged).toBeUndefined();
    expect(found?.branch).toBeUndefined();
  });

  it('counts malformed nested review evidence rather than dropping it', () => {
    // Silence about a risk has to mean silence. `risks: 'none'` is a value the
    // board could not read, and reporting it as "None reported" told a
    // reviewer the child flagged nothing.
    const found = judgementFor([event({ payload: {
      ...GOOD,
      evidence: { tests: [{ command: 3, exitCode: 'zero' }, null], risks: 'none', artifacts: [2], prState: 'maybe' },
    } })], 't1');
    expect(found?.tests).toEqual([]);
    expect(found?.unreadTests).toBe(2);
    expect(found?.risks).toEqual([]);
    expect(found?.unreadRisks).toBe(1);
    expect(found?.artifacts).toEqual([]);
    expect(found?.unreadArtifacts).toBe(1);
    expect(found?.prState).toBeUndefined();
  });

  it('separates a list nobody wrote from one it could not read', () => {
    const absent = judgementFor([event({ payload: GOOD })], 't1');
    expect(absent?.risks).toBeUndefined();
    expect(absent?.unreadRisks).toBe(0);

    const partial = judgementFor([event({ payload: {
      ...GOOD, evidence: { risks: ['a real risk', { note: 'data loss possible' }] },
    } })], 't1');
    expect(partial?.risks).toEqual(['a real risk']);
    expect(partial?.unreadRisks).toBe(1);
  });

  it('does not turn an unsafe PR URL from a malformed event into a link', () => {
    const found = judgementFor([event({ payload: { ...GOOD, evidence: { prUrl: 'javascript:alert(1)' } } })], 't1');
    expect(found?.prUrl).toBeUndefined();
  });

  it('returns the normalized URL that it actually validated', () => {
    const found = judgementFor([event({ payload: { ...GOOD, evidence: { prUrl: ' https://example.com/review ' } } })], 't1');
    expect(found?.prUrl).toBe('https://example.com/review');
  });
});
