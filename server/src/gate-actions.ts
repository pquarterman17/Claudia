import type { FeedStep, PendingQuestion, SessionState } from '@claudia/shared';
import type { ApprovalGate, PermissionResult } from './approval-gate.js';
import { approvalStep, infoStep, summarizeToolInput } from './feed.js';
import { parseQuestions } from './question-parser.js';

/** The slice of a session the user-decision actions need. */
export interface GateCtx {
  gate: ApprovalGate;
  feed: (step: FeedStep) => void;
  setState: (state: SessionState) => void;
  getQuestion: () => PendingQuestion | undefined;
  setQuestion: (question: PendingQuestion) => void;
  clearQuestion: () => void;
}

/**
 * Opens a tool-permission request and parks it until the user decides.
 *
 * `AskUserQuestion` is not really a permission prompt — it is Claude asking
 * something — so it becomes a question picker rather than an approve/deny
 * banner. Both ride the same parked `canUseTool` promise, which is what makes
 * an answer indistinguishable from an approval to the SDK.
 */
export function openPermissionRequest(
  ctx: GateCtx,
  toolName: string,
  input: Record<string, unknown>,
): Promise<PermissionResult> {
  const summary = summarizeToolInput(toolName, input);
  const promise = ctx.gate.request(toolName, summary, input);

  const questions = toolName === 'AskUserQuestion' ? parseQuestions(input) : null;
  if (questions) {
    ctx.setQuestion({ requestId: ctx.gate.current?.requestId ?? '', questions, requestedAt: Date.now() });
    ctx.feed(infoStep('Asked you a question', questions[0]?.question));
  } else {
    ctx.feed(approvalStep(toolName, summary));
  }
  ctx.setState('awaiting_approval');
  return promise;
}

/** Resolves a parked approval; false means a stale click (already settled). */
export function approve(ctx: GateCtx, requestId: string): boolean {
  const pending = ctx.gate.current;
  if (!ctx.gate.approve(requestId)) return false;
  ctx.feed(infoStep('Approved', pending?.summary));
  ctx.setState('working');
  return true;
}

export function deny(ctx: GateCtx, requestId: string, message?: string): boolean {
  const pending = ctx.gate.current;
  if (!ctx.gate.deny(requestId, message)) return false;
  ctx.clearQuestion();
  ctx.feed(infoStep('Denied', message ?? pending?.summary));
  ctx.setState('working');
  return true;
}

/** Answers an AskUserQuestion picker; answers ride back keyed by question text. */
export function answerQuestion(ctx: GateCtx, requestId: string, answers: Record<string, string>): boolean {
  if (ctx.getQuestion()?.requestId !== requestId) return false;
  if (!ctx.gate.approveWith(requestId, { answers })) return false;
  ctx.clearQuestion();
  ctx.feed(infoStep('Answered', Object.values(answers).join(' · ')));
  ctx.setState('working');
  return true;
}
