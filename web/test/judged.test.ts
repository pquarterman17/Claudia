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
});
