import type { SessionManager } from './session-manager.js';

/**
 * Approves every session with a waiting approval, or interrupts every busy
 * one. Pulled out of the gateway's dispatch switch so that file stays a thin
 * router rather than growing its own business logic.
 */
export function runBulk(op: 'approve_all' | 'interrupt_all', manager: SessionManager): void {
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
