import type { FeedStep, PendingQuestion, SessionState } from '@claudia/shared';
import type { ApprovalGate } from './approval-gate.js';
import { infoStep } from './feed.js';

/** The slice of a session the user-decision actions need. */
export interface GateCtx {
  gate: ApprovalGate;
  feed: (step: FeedStep) => void;
  setState: (state: SessionState) => void;
  getQuestion: () => PendingQuestion | undefined;
  clearQuestion: () => void;
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
