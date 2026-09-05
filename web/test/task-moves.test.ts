import { TASK_TRANSITIONS, type TaskStatus } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import { HUMAN_MOVES, MOVE_LABEL } from '../src/task-moves';

/**
 * The buttons the fleet board offers, against the state machine behind them.
 *
 * The plan's whole point in making the transitions DATA was that two halves of
 * the app implement against one table. A UI that offered a move the store
 * refuses would put that back — the button would be there, the click would
 * fail, and the failure would look like a bug in the server.
 */

const ALL = Object.keys(TASK_TRANSITIONS) as TaskStatus[];

describe('the moves a person is offered', () => {
  it('offers nothing the server would refuse', () => {
    for (const from of ALL) {
      for (const to of HUMAN_MOVES[from]) expect(TASK_TRANSITIONS[from]).toContain(to);
    }
  });

  it('covers every status, so a new one cannot be silently unhandled', () => {
    for (const status of ALL) {
      expect(HUMAN_MOVES[status]).toBeDefined();
      expect(MOVE_LABEL[status]).toBeTruthy();
    }
  });

  it('leaves the fleet its own two moves', () => {
    // `ready -> running` reserves a run row in the same transaction, so a
    // person clicking it would hold a concurrency slot with no child in it for
    // the life of the mission. `running -> reported` is the child's claim to
    // have finished, and acceptance is only worth something if the claim comes
    // from the work rather than from the person reviewing it.
    expect(HUMAN_MOVES.ready).not.toContain('running');
    expect(HUMAN_MOVES.running).not.toContain('reported');
    // Both are still real edges — this is a subset, not a disagreement.
    expect(TASK_TRANSITIONS.ready).toContain('running');
    expect(TASK_TRANSITIONS.running).toContain('reported');
  });

  it('lets a person promote, review and retry, which is the point of the surface', () => {
    expect(HUMAN_MOVES.proposed).toContain('ready');
    expect(HUMAN_MOVES.reported).toContain('accepted');
    expect(HUMAN_MOVES.reported).toContain('ready');
    expect(HUMAN_MOVES.failed).toContain('ready');
  });

  it('offers no way out of a terminal state', () => {
    // Not a UI choice: a retry is a new run, and the store refuses these too.
    expect(HUMAN_MOVES.accepted).toEqual([]);
    expect(HUMAN_MOVES.cancelled).toEqual([]);
  });

  it('always offers cancel while there is anything to cancel', () => {
    for (const from of ALL) {
      if (TASK_TRANSITIONS[from].includes('cancelled')) expect(HUMAN_MOVES[from]).toContain('cancelled');
    }
  });
});
