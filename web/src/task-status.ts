import type { TaskStatus } from '@claudia/shared';

/** One status palette for the overview and detailed task rows. */
export const TASK_STATUS_COLOR: Readonly<Record<TaskStatus, string>> = {
  proposed: '#75798c', ready: '#8ab4ff', blocked: '#e0a34f', running: '#7ee0a3',
  reported: '#d2cefd', accepted: '#5fbf7f', failed: '#e07070', cancelled: '#595d6c',
};
