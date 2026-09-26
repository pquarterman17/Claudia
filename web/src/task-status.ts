import type { DependencyState, TaskStatus } from '@claudia/shared';

/** One status palette for the overview and detailed task rows. */
export const TASK_STATUS_COLOR: Readonly<Record<TaskStatus, string>> = {
  proposed: '#75798c', ready: '#8ab4ff', blocked: '#e0a34f', running: '#7ee0a3',
  reported: '#d2cefd', accepted: '#5fbf7f', failed: '#e07070', cancelled: '#595d6c',
};

/** Dependency meaning, distinct from the status of the task it references. */
export const DEPENDENCY_COLOR: Readonly<Record<DependencyState, string>> = {
  satisfied: TASK_STATUS_COLOR.accepted,
  waiting: TASK_STATUS_COLOR.blocked,
  unapproved: TASK_STATUS_COLOR.proposed,
  terminal: TASK_STATUS_COLOR.failed,
  missing: '#c08a8a',
  cycle: '#d991e8',
};

export const DEPENDENCY_EXPLANATION: Readonly<Record<DependencyState, string>> = {
  satisfied: 'Accepted; this prerequisite is complete.',
  waiting: 'Still in progress; this task must wait for it to be accepted.',
  unapproved: 'Proposed but not approved; a person must mark it ready or cancel it.',
  terminal: 'Failed or cancelled; it can no longer satisfy this dependency.',
  missing: 'The referenced task no longer exists in this mission.',
  cycle: 'These tasks depend on each other in a loop and cannot start.',
};
