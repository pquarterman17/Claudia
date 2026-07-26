import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  FeedStep,
  FeedStepPatch,
  ModelUsage,
  NeedsAction,
  PendingQuestion,
  PermissionLaunchMode,
  SessionState,
  SessionSummary,
  SubAgentRun,
} from '@claudia/shared';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { ApprovalGate, type PermissionResult } from './approval-gate.js';
import { AsyncQueue } from './async-queue.js';
import { approvalStep, errorStep, infoStep, summarizeToolInput } from './feed.js';
import { routeMessage } from './message-router.js';
import { parseQuestions } from './question-parser.js';
import { SubAgentTracker } from './sub-agent-tracker.js';
import { ToolTracker } from './tool-tracker.js';

export interface SessionCallbacks {
  onUpdate: (summary: SessionSummary) => void;
  onFeed: (sessionId: string, step: FeedStep) => void;
  onFeedPatch: (sessionId: string, stepId: string, patch: FeedStepPatch) => void;
}

export interface LaunchOptions {
  cwd: string;
  /** Absent means: open the session and wait for the user to type. */
  prompt?: string;
  model?: string;
  permissionMode: PermissionLaunchMode;
}

/**
 * One Claude Code session owned by Claudia, wrapping an Agent SDK `query()`
 * in streaming-input mode. State transitions come from structured SDK events
 * (see message-router) — never from parsing output text.
 */
export class ClaudiaSession {
  readonly id = randomUUID();
  private readonly gate = new ApprovalGate();
  private readonly tools = new ToolTracker();
  private readonly input = new AsyncQueue<unknown>();
  private q: ReturnType<typeof query> | null = null;

  private state: SessionState = 'starting';
  private readonly startedAt = Date.now();
  private lastActivityAt = Date.now();
  private turnStartedAt = Date.now();
  private costUsd = 0;
  private modelUsage: ModelUsage[] = [];
  private model: string | undefined;
  private claudeSessionId: string | undefined;
  private errorMessage: string | undefined;
  private needsAction: NeedsAction | undefined;
  private pendingQuestion: PendingQuestion | undefined;
  private readonly subAgents = new SubAgentTracker();
  /** True until the first prompt is sent, so an empty session reads as idle. */
  private awaitingFirstPrompt = true;
  /** True while swapping the query for a permission change. */
  private relaunching = false;

  constructor(
    private readonly opts: LaunchOptions,
    private readonly cb: SessionCallbacks,
  ) {
    // opts.permissionMode is mutable — setPermissionMode updates it in place.
    this.model = opts.model;
  }

  summary(): SessionSummary {
    return {
      id: this.id,
      name: basename(this.opts.cwd) || this.opts.cwd,
      cwd: this.opts.cwd,
      model: this.model,
      permissionMode: this.opts.permissionMode,
      state: this.state,
      startedAt: this.startedAt,
      lastActivityAt: this.lastActivityAt,
      costUsd: this.costUsd,
      inputTokens: this.modelUsage.reduce((a, m) => a + m.inputTokens + m.cacheReadTokens, 0),
      outputTokens: this.modelUsage.reduce((a, m) => a + m.outputTokens, 0),
      modelUsage: this.modelUsage,
      claudeSessionId: this.claudeSessionId,
      pendingApproval: this.gate.current,
      needsAction: this.needsAction,
      pendingQuestion: this.pendingQuestion,
      errorMessage: this.errorMessage,
    };
  }

  start(): void {
    if (this.opts.prompt?.trim()) {
      this.beginQuery();
      this.pushUserText(this.opts.prompt);
      this.awaitingFirstPrompt = false;
      return;
    }
    // No prompt: don't spawn anything yet. The SDK emits its init message only
    // once it has input, so starting a query here would leave the session stuck
    // in 'starting' forever — and it would hold a process doing nothing.
    this.cb.onFeed(this.id, infoStep('Session ready', 'waiting for your first prompt'));
    this.setState('idle');
  }

  /** Creates the SDK query on first use. Safe to call repeatedly. */
  private beginQuery(): void {
    if (this.q) return;
    this.q = query({
      prompt: this.input as AsyncIterable<never>,
      options: {
        cwd: this.opts.cwd,
        ...(this.opts.model ? { model: this.opts.model } : {}),
        permissionMode: this.opts.permissionMode,
        canUseTool: (toolName, input) => this.onPermissionRequest(toolName, input),
      },
    });
    void this.consume();
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.q as AsyncIterable<Record<string, unknown>>) {
        this.applyMessage(message);
      }
      // A relaunch closes the old query on purpose; that is not the end of the
      // session, so don't mark it stopped.
      if (this.relaunching) return;
      if (this.state !== 'error') this.setState('stopped');
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private applyMessage(message: Record<string, unknown>): void {
    this.lastActivityAt = Date.now();
    const routed = routeMessage(message, this.turnStartedAt);

    for (const step of routed.steps) this.cb.onFeed(this.id, step);

    for (const start of routed.toolStarts ?? []) this.tools.begin(start.toolUseId, start.stepId);
    for (const end of routed.toolEnds ?? []) {
      const done = this.tools.complete(end.toolUseId, end.isError);
      if (done) {
        this.cb.onFeedPatch(this.id, done.stepId, {
          durMs: done.durMs,
          status: done.isError ? 'error' : 'ok',
        });
      }
    }

    if (routed.claudeSessionId) this.claudeSessionId = routed.claudeSessionId;
    if (routed.model) this.model = routed.model;
    // Cost and usage are cumulative in the SDK's result message — assign, never add.
    if (routed.costUsd !== undefined) this.costUsd = routed.costUsd;
    if (routed.modelUsage) this.modelUsage = routed.modelUsage;
    if (routed.errorMessage) this.errorMessage = routed.errorMessage;
    if (routed.needsAction !== undefined) this.needsAction = routed.needsAction ?? undefined;
    if (routed.subAgent) this.mergeSubAgent(routed.subAgent.toolUseId, routed.subAgent.run);

    // An empty session is idle, not working: the SDK has started but there is
    // nothing for it to do until someone types.
    if (this.awaitingFirstPrompt && routed.state === 'working') {
      this.setState('idle');
      return;
    }
    // A parked approval outranks a 'working' hint from a message that raced it.
    if (routed.state && !(this.gate.isWaiting && routed.state === 'working')) {
      this.setState(routed.state);
    } else {
      this.cb.onUpdate(this.summary());
    }
  }

  private onPermissionRequest(toolName: string, input: Record<string, unknown>): Promise<PermissionResult> {
    const summary = summarizeToolInput(toolName, input);
    const promise = this.gate.request(toolName, summary, input);

    // AskUserQuestion is not really a permission: it is a question whose answer
    // rides back on the same callback. Render it as a picker instead.
    const questions = toolName === 'AskUserQuestion' ? parseQuestions(input) : null;
    if (questions) {
      this.pendingQuestion = {
        requestId: this.gate.current?.requestId ?? '',
        questions,
        requestedAt: Date.now(),
      };
      this.cb.onFeed(this.id, infoStep('Asked you a question', questions[0]?.question));
    } else {
      this.cb.onFeed(this.id, approvalStep(toolName, summary));
    }
    this.setState('awaiting_approval');
    return promise;
  }

  /** Answers an outstanding question, keyed by question text. */
  answerQuestion(requestId: string, answers: Record<string, string>): boolean {
    if (this.pendingQuestion?.requestId !== requestId) return false;
    if (!this.gate.approveWith(requestId, { answers })) return false;
    this.pendingQuestion = undefined;
    this.cb.onFeed(this.id, infoStep('Answered', Object.values(answers).join(' · ')));
    this.setState('working');
    return true;
  }

  approve(requestId: string): boolean {
    const pending = this.gate.current;
    if (!this.gate.approve(requestId)) return false;
    this.cb.onFeed(this.id, infoStep('Approved', pending?.summary));
    this.setState('working');
    return true;
  }

  deny(requestId: string, message?: string): boolean {
    const pending = this.gate.current;
    if (!this.gate.deny(requestId, message)) return false;
    this.pendingQuestion = undefined;
    this.cb.onFeed(this.id, infoStep('Denied', message ?? pending?.summary));
    this.setState('working');
    return true;
  }

  sendPrompt(text: string): void {
    this.awaitingFirstPrompt = false;
    this.needsAction = undefined;
    this.beginQuery();
    this.pushUserText(text);
    this.lastActivityAt = Date.now();
    this.cb.onFeed(this.id, infoStep('Prompt sent', text.length > 160 ? `${text.slice(0, 159)}…` : text));
    this.setState('working');
  }

  /**
   * Change permissions on a running session.
   *
   * Tightening applies in place. Loosening cannot: the SDK refuses with
   * "the session was not launched with --dangerously-skip-permissions", the
   * same restriction `claude` has in a terminal. So the session is relaunched
   * with `resume`, which preserves the whole conversation — the terminal
   * workflow of restarting with the flag, done automatically.
   *
   * Returns how it was applied so the UI can say which happened.
   */
  async setPermissionMode(mode: PermissionLaunchMode): Promise<'in-place' | 'relaunched' | 'unchanged'> {
    if (this.opts.permissionMode === mode) return 'unchanged';

    const q = this.q as { setPermissionMode?: (m: PermissionLaunchMode) => Promise<void> } | null;
    if (q?.setPermissionMode) {
      try {
        await q.setPermissionMode(mode);
        this.opts.permissionMode = mode;
        this.cb.onFeed(this.id, infoStep('Permission mode', describeMode(mode)));
        this.cb.onUpdate(this.summary());
        return 'in-place';
      } catch {
        // Expected when loosening; fall through to a resuming relaunch.
      }
    }

    await this.relaunchWith(mode);
    return 'relaunched';
  }

  /**
   * Tears down the current query and starts a new one that resumes the same
   * Claude session, so history survives. Used where the mode cannot change in
   * place.
   */
  private async relaunchWith(mode: PermissionLaunchMode): Promise<void> {
    const resumeId = this.claudeSessionId;
    this.gate.abandon('Restarting with new permissions');
    this.abandonRunningTools('session restarted');
    this.relaunching = true;
    try {
      (this.q as { close?: () => void } | null)?.close?.();
    } catch {
      /* already closed */
    }
    this.q = null;
    this.opts.permissionMode = mode;

    this.cb.onFeed(
      this.id,
      infoStep(
        'Restarted with new permissions',
        `${describeMode(mode)}${resumeId ? ' · conversation kept' : ''}`,
      ),
    );

    this.q = query({
      prompt: this.input as AsyncIterable<never>,
      options: {
        cwd: this.opts.cwd,
        ...(this.opts.model ? { model: this.opts.model } : {}),
        ...(resumeId ? { resume: resumeId } : {}),
        permissionMode: mode,
        canUseTool: (toolName, input) => this.onPermissionRequest(toolName, input),
      },
    });
    this.relaunching = false;
    void this.consume();
    this.cb.onUpdate(this.summary());
  }

  async interrupt(): Promise<void> {
    const q = this.q as { interrupt?: () => Promise<unknown> } | null;
    if (!q?.interrupt) return;
    await q.interrupt().catch(() => undefined);
    this.cb.onFeed(this.id, infoStep('Interrupted'));
    this.setState('idle');
  }

  stop(): void {
    this.gate.abandon('Session stopped');
    this.abandonRunningTools('session stopped');
    this.input.close();
    try {
      (this.q as { close?: () => void } | null)?.close?.();
    } catch {
      /* already closed */
    }
    this.setState('stopped');
  }

  private fail(message: string): void {
    this.errorMessage = message;
    this.gate.abandon(`Session failed: ${message}`);
    this.abandonRunningTools(message);
    this.cb.onFeed(this.id, errorStep('Session error', message));
    this.setState('error');
  }

  /**
   * Folds a sub-agent update into the Task step that spawned it, so the feed
   * shows nested children rather than one opaque line sitting for minutes.
   */
  private mergeSubAgent(toolUseId: string, run: Partial<SubAgentRun> & { taskId: string }): void {
    const stepId = this.tools.stepFor(toolUseId);
    if (!stepId) return;
    this.cb.onFeedPatch(this.id, stepId, { subAgents: this.subAgents.merge(stepId, run) });
  }

  /** Stop any tool step spinning forever when its result can no longer arrive. */
  private abandonRunningTools(reason: string): void {
    for (const stepId of this.tools.outstanding()) {
      this.cb.onFeedPatch(this.id, stepId, { status: 'error', meta: `did not finish — ${reason}` });
    }
    for (const { stepId, runs } of this.subAgents.abandon()) {
      this.cb.onFeedPatch(this.id, stepId, { subAgents: runs });
    }
    this.tools.clear();
  }

  private pushUserText(text: string): void {
    this.turnStartedAt = Date.now();
    this.input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: this.claudeSessionId ?? '',
    });
  }

  private setState(state: SessionState): void {
    if (this.state === 'stopped' && state !== 'stopped') return;
    this.state = state;
    this.cb.onUpdate(this.summary());
  }
}

/** Plain-English description of a permission mode, for the feed. */
function describeMode(mode: PermissionLaunchMode): string {
  switch (mode) {
    case 'bypassPermissions':
      return 'permissions skipped — tools run without asking';
    case 'acceptEdits':
      return 'edits auto-accepted; commands still ask';
    case 'auto':
      return 'auto — Claude decides what needs asking';
    default:
      return 'approvals required';
  }
}
