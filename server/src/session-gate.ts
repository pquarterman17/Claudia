import type { FeedStep, PendingQuestion, SessionState } from '@claudia/shared';
import { ApprovalGate } from './approval-gate.js';
import * as gateActions from './gate-actions.js';

/**
 * A session's decision surface: the parked `canUseTool` promise, the question
 * it may be asking, and the four things a user can do about them.
 *
 * Pulled out of ClaudiaSession because the two halves belong together and were
 * split across it — the gate was a field, the pending question a second field,
 * and the context binding them was rebuilt at five call sites. Keeping them in
 * one place means the question can never be set on one session's gate and read
 * from another's, and it takes a context builder out of a file that had grown
 * three of them.
 */
export class SessionGate {
  private readonly gate = new ApprovalGate();
  private question: PendingQuestion | undefined;

  constructor(
    private readonly deps: {
      feed: (step: FeedStep) => void;
      setState: (state: SessionState) => void;
      cwd: () => string;
    },
  ) {}

  /** The raw gate, for the summary builder and the driver's approval callback. */
  get raw(): ApprovalGate {
    return this.gate;
  }

  /** True while a decision is parked — which outranks a 'working' hint from a
   * message that raced it. */
  get isWaiting(): boolean {
    return this.gate.isWaiting;
  }

  get pending(): PendingQuestion | undefined {
    return this.question;
  }

  ctx(): gateActions.GateCtx {
    return {
      gate: this.gate,
      feed: this.deps.feed,
      setState: this.deps.setState,
      getQuestion: () => this.question,
      setQuestion: (q) => (this.question = q),
      clearQuestion: () => (this.question = undefined),
    };
  }

  answerQuestion(requestId: string, answers: Record<string, string>) { return gateActions.answerQuestion(this.ctx(), requestId, answers); }
  approve(requestId: string) { return gateActions.approve(this.ctx(), requestId); }
  deny(requestId: string, message?: string) { return gateActions.deny(this.ctx(), requestId, message); }
  alwaysAllowProject(requestId: string) { return gateActions.alwaysAllowProject(this.ctx(), requestId, this.deps.cwd()); }

  abandon(reason: string): void {
    this.gate.abandon(reason);
  }
}
