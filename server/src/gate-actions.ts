import type { FeedStep, PendingQuestion, SessionState } from '@claudia/shared';
import type { ApprovalGate, PermissionResult } from './approval-gate.js';
import { approvalStep, infoStep, summarizeToolInput } from './feed.js';
import { deriveAllowRule } from './permission-rules.js';
import { parseQuestions } from './question-parser.js';
import { addAllowRule } from './settings-writer.js';

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

export interface AlwaysAllowResult {
  ok: boolean;
  /** The rule that was written on success; a user-facing reason on failure. */
  message: string;
}

/**
 * Writes a standing allow rule for the pending call into the project's
 * .claude/settings.local.json, then approves the call it was derived from.
 *
 * Re-derives the rule from the gate's OWN stored input rather than trusting
 * anything the client sends — the client only ever echoed back a preview
 * string for display, and this is the one function that actually grants
 * standing permission, so it must not take rule text as an argument.
 */
export async function alwaysAllowProject(ctx: GateCtx, requestId: string, cwd: string): Promise<AlwaysAllowResult> {
  const pending = ctx.gate.current;
  const input = ctx.gate.rawInputFor(requestId);
  if (!pending || pending.requestId !== requestId || !input) {
    return { ok: false, message: 'That approval is no longer waiting.' };
  }
  const rule = deriveAllowRule(pending.toolName, input);
  if (!rule) return { ok: false, message: 'This tool call has no safe, narrow rule to always-allow.' };

  const written = await addAllowRule(cwd, rule);
  if (!written.ok) return { ok: false, message: written.error ?? 'Could not write the settings file.' };

  approve(ctx, requestId);
  ctx.feed(infoStep(
    written.alreadyPresent ? 'Already allowed in this project' : 'Always allowed in this project',
    `${rule} — .claude/settings.local.json`,
  ));
  return { ok: true, message: rule };
}
