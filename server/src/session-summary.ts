import type {
  ModelUsage,
  NeedsAction,
  PendingQuestion,
  SessionState,
  SessionSummary,
} from '@claudia/shared';
import { basename } from 'node:path';
import type { ApprovalGate } from './approval-gate.js';
import type { LaunchOptions } from './session-contract.js';

export interface SessionSummaryState {
  id: string;
  state: SessionState;
  startedAt: number;
  lastActivityAt: number;
  costUsd: number;
  modelUsage: ModelUsage[];
  model: string | undefined;
  selectedModel: string | undefined;
  claudeSessionId: string | undefined;
  errorMessage: string | undefined;
  needsAction: NeedsAction | undefined;
  pendingQuestion: PendingQuestion | undefined;
  customTitle: string | undefined;
  generatedTitle: string | undefined;
  effortLevel: SessionSummary['effortLevel'];
  thinkingMode: SessionSummary['thinkingMode'];
  contextUsage: SessionSummary['contextUsage'];
  contextPending: boolean;
}

/** Builds the wire-format session snapshot without exposing mutable session state. */
export function buildSessionSummary(
  opts: LaunchOptions,
  gate: ApprovalGate,
  promptQueue: { list(): string[] },
  state: SessionSummaryState,
): SessionSummary {
  return {
    id: state.id,
    name: basename(opts.cwd) || opts.cwd,
    title: state.customTitle ?? state.generatedTitle,
    cwd: opts.cwd,
    model: state.model,
    selectedModel: state.selectedModel,
    permissionMode: opts.permissionMode,
    effortLevel: state.effortLevel,
    thinkingMode: state.thinkingMode,
    contextUsage: state.contextUsage,
    contextPending: state.contextPending,
    state: state.state,
    startedAt: state.startedAt,
    lastActivityAt: state.lastActivityAt,
    costUsd: state.costUsd,
    inputTokens: state.modelUsage.reduce((total, usage) => total + usage.inputTokens + usage.cacheReadTokens, 0),
    outputTokens: state.modelUsage.reduce((total, usage) => total + usage.outputTokens, 0),
    modelUsage: state.modelUsage,
    claudeSessionId: state.claudeSessionId,
    pendingApproval: gate.current,
    needsAction: state.needsAction,
    pendingQuestion: state.pendingQuestion,
    errorMessage: state.errorMessage,
    queuedPrompts: promptQueue.list(),
  };
}
