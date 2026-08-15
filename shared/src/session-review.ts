/** A bounded, typed preview for a pending file mutation. */
export interface ApprovalChange {
  kind: 'edit' | 'write';
  path: string;
  before?: string;
  after: string;
  truncated: boolean;
}

/** A current item from Claude Code's structured TodoWrite tool. */
export interface SessionTodo {
  content: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
}
