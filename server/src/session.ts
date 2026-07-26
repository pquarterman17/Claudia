import type {
  FeedStep,
  ModelChoice,
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
import type { LaunchOptions, SessionCallbacks } from './session-contract.js';
import { AsyncQueue } from './async-queue.js';
import { DraftBuffer } from './draft-buffer.js';
import { approvalStep, errorStep, infoStep, summarizeToolInput } from './feed.js';
import * as gateActions from './gate-actions.js';
import { routeMessage } from './message-router.js';
import { autoTitle, listModels, type ParityQuery } from './parity-controls.js';
import { TranscriptLog } from './transcript-log.js';
import { abandonRunningSteps, patchSubAgent } from './step-patcher.js';
import { createSessionQuery, userMessage } from './query-factory.js';
import { describeMode } from './permission-labels.js';
import { switchPermissionMode } from './permission-switch.js';
import { parseQuestions } from './question-parser.js';
import { PromptQueue } from './prompt-queue.js';
import { SubAgentTracker } from './sub-agent-tracker.js';
import { ToolTracker } from './tool-tracker.js';

/**
 * One Claude Code session owned by Claudia, wrapping an Agent SDK `query()`
 * in streaming-input mode. State transitions come from structured SDK events
 * (see message-router) — never from parsing output text.
 */
export type { LaunchOptions, SessionCallbacks } from './session-contract.js';

export class ClaudiaSession {
  readonly id = randomUUID();
  private readonly gate = new ApprovalGate();
  private readonly tools = new ToolTracker();
  /** Recreated per query: two queries must never share one input iterator. */
  private input = new AsyncQueue<unknown>();
  /**
   * Bumped on every relaunch. A consume loop belongs to one generation; when
   * an outdated loop finally terminates it must change nothing. A boolean flag
   * cannot express this — the relaunch sets and clears it within one
   * synchronous block, while the old loop only observes termination on a later
   * microtask, by which point the flag was already false again. That exact
   * race marked live sessions 'stopped' and swallowed the next prompt.
   */
  private queryGen = 0;
  private q: ReturnType<typeof createSessionQuery> | null = null;

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
  private readonly promptQueue = new PromptQueue();
  private readonly draft = new DraftBuffer();
  readonly transcript = new TranscriptLog();
  private customTitle: string | undefined;
  private generatedTitle: string | undefined;
  private firstPrompt: string | undefined;
  /** True until the first prompt is sent, so an empty session reads as idle. */
  private awaitingFirstPrompt = true;

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
      title: this.customTitle ?? this.generatedTitle,
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
      queuedPrompts: this.promptQueue.list(),
    };
  }

  start(): void {
    if (this.opts.prompt?.trim()) {
      this.firstPrompt = this.opts.prompt;
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
    this.q = createSessionQuery({
      cwd: this.opts.cwd,
      model: this.opts.model,
      permissionMode: this.opts.permissionMode,
      input: this.input,
      onPermission: (toolName, input) => this.onPermissionRequest(toolName, input),
    });
    void this.consume(this.queryGen);
  }

  private async consume(gen: number): Promise<void> {
    try {
      for await (const message of this.q as AsyncIterable<Record<string, unknown>>) {
        if (gen !== this.queryGen) return; // superseded mid-iteration
        this.applyMessage(message);
      }
      // Only the current generation may declare the session over — an old
      // loop ending is just its query having been replaced.
      if (gen !== this.queryGen) return;
      if (this.state !== 'error') this.setState('stopped');
    } catch (err) {
      if (gen !== this.queryGen) return;
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private applyMessage(message: Record<string, unknown>): void {
    this.lastActivityAt = Date.now();
    const routed = routeMessage(message, this.turnStartedAt);

    // Streamed fragment of the in-progress reply; throttled by the buffer.
    if (routed.draftDelta !== undefined) {
      const emit = this.draft.append(routed.draftDelta);
      if (emit !== null) this.cb.onDraft(this.id, emit);
      return; // a delta carries nothing else
    }
    // A complete step supersedes the draft it was streamed from.
    if (routed.steps.length > 0 && this.draft.clear()) this.cb.onDraft(this.id, null);

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
    // A result also ends the current turn, so the next queued prompt (if any)
    // becomes the active one.
    if (routed.costUsd !== undefined) {
      this.costUsd = routed.costUsd;
      this.promptQueue.shift();
      if (!this.generatedTitle && !this.customTitle && this.firstPrompt) {
        void autoTitle(this.q as ParityQuery | null, this.firstPrompt).then((title) => {
          if (title && !this.customTitle) {
            this.generatedTitle = title;
            this.cb.onUpdate(this.summary());
          }
        });
      }
    }
    if (routed.modelUsage) this.modelUsage = routed.modelUsage;
    if (routed.errorMessage) this.errorMessage = routed.errorMessage;
    if (routed.needsAction !== undefined) this.needsAction = routed.needsAction ?? undefined;
    if (routed.subAgent) {
      patchSubAgent(this.tools, this.subAgents, (id, p) => this.cb.onFeedPatch(this.id, id, p), routed.subAgent.toolUseId, routed.subAgent.run);
    }

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

  private gateCtx(): gateActions.GateCtx {
    return {
      gate: this.gate,
      feed: (step) => this.cb.onFeed(this.id, step),
      setState: (state) => this.setState(state),
      getQuestion: () => this.pendingQuestion,
      clearQuestion: () => (this.pendingQuestion = undefined),
    };
  }

  answerQuestion(requestId: string, answers: Record<string, string>): boolean {
    return gateActions.answerQuestion(this.gateCtx(), requestId, answers);
  }

  approve(requestId: string): boolean {
    return gateActions.approve(this.gateCtx(), requestId);
  }

  deny(requestId: string, message?: string): boolean {
    return gateActions.deny(this.gateCtx(), requestId, message);
  }

  /** Empty title reverts to the auto-generated one. */
  rename(title: string): void {
    this.customTitle = title.trim() || undefined;
    this.cb.onUpdate(this.summary());
  }

  async switchModel(model: string): Promise<void> {
    const q = this.q as ParityQuery | null;
    await q?.setModel?.(model).catch(() => undefined);
    this.model = model;
    this.cb.onFeed(this.id, infoStep('Model switched', model));
    this.cb.onUpdate(this.summary());
  }

  models(): Promise<ModelChoice[]> {
    return listModels(this.q as ParityQuery | null);
  }

  sendPrompt(text: string): void {
    // A prompt sent while a turn is already in flight joins the SDK's input
    // queue rather than starting immediately — track it so the UI can show it.
    if (this.state === 'working' || this.state === 'awaiting_approval' || this.state === 'starting') {
      this.promptQueue.push(text);
    }
    this.awaitingFirstPrompt = false;
    this.needsAction = undefined;
    if (!this.firstPrompt) this.firstPrompt = text;
    this.beginQuery();
    this.pushUserText(text);
    this.lastActivityAt = Date.now();
    this.cb.onFeed(this.id, infoStep('Prompt sent', text.length > 160 ? `${text.slice(0, 159)}…` : text));
    this.setState('working');
  }

  /** See permission-switch.ts — tighten in place, loosen via resuming relaunch. */
  setPermissionMode(mode: PermissionLaunchMode): Promise<'in-place' | 'relaunched' | 'unchanged'> {
    return switchPermissionMode(
      {
        getMode: () => this.opts.permissionMode,
        setMode: (m) => (this.opts.permissionMode = m),
        getQuery: () => this.q,
        getInput: () => this.input,
        setInput: (queue) => (this.input = queue),
        bumpGeneration: () => (this.queryGen += 1),
        resumeId: () => this.claudeSessionId,
        abandonForRestart: () => {
          this.gate.abandon('Restarting with new permissions');
          if (this.draft.clear()) this.cb.onDraft(this.id, null);
          abandonRunningSteps(this.tools, this.subAgents, (id, p) => this.cb.onFeedPatch(this.id, id, p), 'session restarted');
          this.queryGen += 1;
        },
        feedInfo: (title, meta) => this.cb.onFeed(this.id, infoStep(title, meta)),
        updated: () => this.cb.onUpdate(this.summary()),
        replaceQuery: (m, resume, input) => {
          this.q = createSessionQuery({
            cwd: this.opts.cwd,
            model: this.opts.model,
            permissionMode: m,
            resume,
            input,
            onPermission: (toolName, toolInput) => this.onPermissionRequest(toolName, toolInput),
          });
          void this.consume(this.queryGen);
        },
      },
      mode,
    );
  }

  async interrupt(): Promise<void> {
    const q = this.q as { interrupt?: () => Promise<unknown> } | null;
    if (!q?.interrupt) return;
    await q.interrupt().catch(() => undefined);
    this.cb.onFeed(this.id, infoStep('Interrupted'));
    this.setState('idle');
  }

  stop(): void {
    if (this.draft.clear()) this.cb.onDraft(this.id, null);
    this.gate.abandon('Session stopped');
    abandonRunningSteps(this.tools, this.subAgents, (id, p) => this.cb.onFeedPatch(this.id, id, p), 'session stopped');
    this.promptQueue.clear();
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
    abandonRunningSteps(this.tools, this.subAgents, (id, p) => this.cb.onFeedPatch(this.id, id, p), message);
    this.promptQueue.clear();
    this.cb.onFeed(this.id, errorStep('Session error', message));
    this.setState('error');
  }

  private pushUserText(text: string): void {
    this.turnStartedAt = Date.now();
    this.input.push(userMessage(text, this.claudeSessionId));
  }

  private setState(state: SessionState): void {
    if (this.state === 'stopped' && state !== 'stopped') return;
    this.state = state;
    this.cb.onUpdate(this.summary());
  }
}
