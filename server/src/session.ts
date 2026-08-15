import type {
  FeedStep,
  EffortLevel,
  ModelChoice,
  ModelUsage,
  NeedsAction,
  PendingQuestion,
  PermissionLaunchMode,
  SessionState,
  SubAgentRun,
  TranscriptItem,
  ThinkingMode,
} from '@claudia/shared';
import { randomUUID } from 'node:crypto';
import { ApprovalGate, type PermissionResult } from './approval-gate.js';
import type { LaunchOptions, SessionCallbacks } from './session-contract.js';
import { AsyncQueue } from './async-queue.js';
import { DraftBuffer } from './draft-buffer.js';
import { approvalStep, errorStep, infoStep, summarizeToolInput } from './feed.js';
import * as gateActions from './gate-actions.js';
import { routeMessage } from './message-router.js';
import { autoTitle, listCommands, listModels, modelMatches, type ParityQuery } from './parity-controls.js';
import { TranscriptLog } from './transcript-log.js';
import { abandonRunningSteps, patchSubAgent } from './step-patcher.js';
import { createSessionQuery, userMessage } from './query-factory.js';
import { describeMode } from './permission-labels.js';
import { switchPermissionMode } from './permission-switch.js';
import { parseQuestions } from './question-parser.js';
import { PromptQueue } from './prompt-queue.js';
import { SubAgentTracker } from './sub-agent-tracker.js';
import { buildSessionSummary } from './session-summary.js';
import { ToolTracker } from './tool-tracker.js';
import { SessionRuntimeControls, type RuntimeControlQuery } from './session-runtime-controls.js';
import { rewindFiles, type RewindResult } from './file-checkpoints.js';

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
  private input = new AsyncQueue<unknown>();
  /** Bumped on relaunch so outdated consume loops cannot mutate current state. */
  private queryGen = 0;
  private q: ReturnType<typeof createSessionQuery> | null = null;

  private state: SessionState = 'starting';
  private readonly startedAt = Date.now();
  private lastActivityAt = Date.now();
  private turnStartedAt = Date.now();
  private costUsd = 0;
  private modelUsage: ModelUsage[] = [];
  private model: string | undefined;
  private selectedModel: string | undefined;
  private claudeSessionId: string | undefined;
  private errorMessage: string | undefined;
  private needsAction: NeedsAction | undefined;
  private pendingQuestion: PendingQuestion | undefined;
  private readonly subAgents = new SubAgentTracker();
  private readonly promptQueue = new PromptQueue();
  private readonly draft = new DraftBuffer();
  private readonly controls: SessionRuntimeControls;
  readonly transcript = new TranscriptLog();
  private customTitle: string | undefined;
  private generatedTitle: string | undefined;
  private firstPrompt: string | undefined;
  private awaitingFirstPrompt = true;

  constructor(
    private readonly opts: LaunchOptions,
    private readonly cb: SessionCallbacks,
  ) {
    // opts.permissionMode is mutable — setPermissionMode updates it in place.
    this.model = opts.model;
    this.controls = new SessionRuntimeControls(opts.effortLevel, opts.thinkingMode);
  }

  summary() {
    return buildSessionSummary(this.opts, this.gate, this.promptQueue, {
      id: this.id,
      state: this.state,
      startedAt: this.startedAt,
      lastActivityAt: this.lastActivityAt,
      costUsd: this.costUsd,
      modelUsage: this.modelUsage,
      model: this.model,
      selectedModel: this.selectedModel,
      claudeSessionId: this.claudeSessionId,
      errorMessage: this.errorMessage,
      needsAction: this.needsAction,
      pendingQuestion: this.pendingQuestion,
      customTitle: this.customTitle,
      generatedTitle: this.generatedTitle,
      effortLevel: this.controls.effortLevel,
      thinkingMode: this.controls.thinkingMode,
      contextUsage: this.controls.contextUsage,
      contextPending: this.controls.contextPending,
    });
  }

  start(): void {
    if (this.opts.prompt?.trim()) {
      this.firstPrompt = this.opts.prompt;
      this.beginQuery();
      this.pushUserText(this.opts.prompt);
      const item: TranscriptItem = { ts: Date.now(), kind: 'user', text: this.opts.prompt };
      this.transcript.append(item);
      this.cb.onTranscript(this.id, item);
      this.awaitingFirstPrompt = false;
      return;
    }
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
      effortLevel: this.controls.effortLevel,
      thinkingMode: this.controls.thinkingMode,
      resume: this.opts.resume,
      forkSession: this.opts.forkSession,
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

    if (routed.draftDelta !== undefined) {
      const emit = this.draft.append(routed.draftDelta);
      if (emit !== null) this.cb.onDraft(this.id, emit);
      return; // a delta carries nothing else
    }
    if (routed.steps.length > 0 && this.draft.clear()) this.cb.onDraft(this.id, null);

    for (const step of routed.steps) this.cb.onFeed(this.id, step);
    for (const item of routed.transcriptItems ?? []) {
      this.transcript.append(item);
      this.cb.onTranscript(this.id, item);
      this.controls.capture(item);
    }

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
    if (routed.model) {
      this.model = routed.model;
      if (modelMatches(this.selectedModel, routed.model)) this.selectedModel = undefined;
    }
    if (routed.slashCommands) this.cb.onCommands(this.id, routed.slashCommands);
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

  rename(title: string): void {
    this.customTitle = title.trim() || undefined;
    this.cb.onUpdate(this.summary());
  }

  async switchModel(model: string): Promise<void> {
    const q = this.q as ParityQuery | null;
    await q?.setModel?.(model).catch(() => undefined);
    this.selectedModel = model;
    this.cb.onFeed(this.id, infoStep('Model switched', `${model} — from the next turn`));
    this.cb.onUpdate(this.summary());
  }

  async setEffort(effortLevel: EffortLevel): Promise<void> {
    await this.controls.setEffort(this.q as RuntimeControlQuery | null, effortLevel).catch(() => undefined);
    this.cb.onFeed(this.id, infoStep('Effort changed', effortLevel));
    this.cb.onUpdate(this.summary());
  }

  async setThinking(thinkingMode: ThinkingMode): Promise<void> {
    await this.controls.setThinking(this.q as RuntimeControlQuery | null, thinkingMode).catch(() => undefined);
    this.cb.onFeed(this.id, infoStep('Thinking changed', thinkingMode));
    this.cb.onUpdate(this.summary());
  }

  refreshContext(): void {
    if (this.controls.contextPending) return;
    this.controls.requestContext(() => this.sendPrompt('/context'));
    this.cb.onUpdate(this.summary());
  }

  models(): Promise<ModelChoice[]> {
    return listModels(this.q as ParityQuery | null);
  }

  commands() {
    return listCommands(this.q as ParityQuery | null);
  }

  sendPrompt(text: string): void {
    if (this.state === 'working' || this.state === 'awaiting_approval' || this.state === 'starting') {
      this.promptQueue.push(text);
    }
    this.awaitingFirstPrompt = false;
    this.needsAction = undefined;
    if (!this.firstPrompt) this.firstPrompt = text;
    this.beginQuery();
    this.pushUserText(text);
    const item: TranscriptItem = { ts: Date.now(), kind: 'user', text };
    this.transcript.append(item);
    this.cb.onTranscript(this.id, item);
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
            effortLevel: this.controls.effortLevel,
            thinkingMode: this.controls.thinkingMode,
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

  rewindFiles(checkpointId: string): Promise<RewindResult> {
    return rewindFiles(this.q, checkpointId);
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
