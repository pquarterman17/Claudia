/** A bounded, typed preview for a pending file mutation. */
export interface FileApprovalChange {
  kind: 'edit' | 'write';
  path: string;
  before?: string;
  after: string;
  truncated: boolean;
}

/**
 * A bounded preview of a plan proposed via ExitPlanMode. Kept separate from
 * FileApprovalChange rather than bolted onto it with optional fields — a plan
 * has no path/before/after, and a union keeps each shape honest.
 */
export interface PlanApprovalChange {
  kind: 'plan';
  /** Markdown plan text (bounded — see PLAN_PREVIEW_LIMIT in approval-change.ts). */
  plan: string;
  /** Absolute path to the CLI's on-disk copy, e.g. ~/.claude/plans/<slug>.md. */
  planFilePath: string;
  truncated: boolean;
}

export type ApprovalChange = FileApprovalChange | PlanApprovalChange;

/** A current item from Claude Code's structured TodoWrite tool. */
export interface SessionTodo {
  content: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
}
