import { TASK_TRANSITIONS, type TaskStatus } from '@claudia/shared';

/**
 * The moves a person is offered, which is not every move the machine allows.
 *
 * `TASK_TRANSITIONS` is the whole state machine, and some of its edges belong
 * to the fleet rather than to a human. `ready -> running` is the pulse's, and
 * it is paid for: the reconciler reserves a run row in the same transaction, so
 * a task moved to `running` from a button would occupy a concurrency slot with
 * no child in it, for the life of the mission. `running -> reported` is the
 * child's claim that it finished, and the whole completion contract rests on
 * that claim coming from the work rather than from the person reviewing it.
 *
 * So this is a deliberate subset, not a filter that happens to be applied. A
 * person can promote, block, unblock, accept, reject, retry and cancel — every
 * decision that is theirs — and cannot fabricate the two the fleet has to
 * observe for itself. `web/test/task-moves.test.ts` proves every move here is
 * one the server would actually accept, so the UI can never offer a button
 * that fails.
 */
export const HUMAN_MOVES: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  // The promotion this whole surface exists for: a described task is not an
  // instruction to spend money until somebody says so.
  proposed: ['ready', 'cancelled'],
  ready: ['blocked', 'cancelled'],
  blocked: ['ready', 'cancelled'],
  // Stopping is a human decision. Declaring a live run failed is the
  // watchdog's, and it has evidence this button would not.
  running: ['cancelled'],
  // Review, and its three honest outcomes: take it, reject it, send it back.
  reported: ['accepted', 'failed', 'ready', 'cancelled'],
  failed: ['ready', 'cancelled'],
  accepted: [],
  cancelled: [],
};

/** How the move reads on the button, rather than as a state name. */
export const MOVE_LABEL: Readonly<Record<TaskStatus, string>> = {
  proposed: 'propose',
  ready: 'ready',
  blocked: 'block',
  running: 'run',
  reported: 'report',
  accepted: 'accept',
  failed: 'reject',
  cancelled: 'cancel',
};
