import type { SessionManager } from './session-manager.js';

/**
 * Approves every pending approval, or interrupts every running session,
 * across the whole board at once. Split out of Gateway so its dispatch table
 * stays a thin router rather than growing case bodies — and so this logic is
 * testable without a socket.
 */
export function runBulkOp(manager: SessionManager, op: 'approve_all' | 'interrupt_all'): void {
  for (const summary of manager.summaries()) {
    const session = manager.get(summary.id);
    if (!session) continue;
    if (op === 'approve_all') {
      // Skip questions: "approving" one would resolve it with no answer.
      if (summary.pendingApproval && !summary.pendingQuestion) {
        session.approve(summary.pendingApproval.requestId);
      }
    } else if (summary.state === 'working' || summary.state === 'starting') {
      void session.interrupt();
    }
  }
}
