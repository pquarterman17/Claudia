import type {
  EffortLevel,
  ModelChoice,
  ModelUsage,
  NeedsAction,
  PendingQuestion,
  PermissionLaunchMode,
  PromptImage,
  SessionState,
  TranscriptItem,
  ThinkingMode,
} from '@claudia/shared';
import { randomUUID } from 'node:crypto';
import { ApprovalGate } from './approval-gate.js';
import type { LaunchOptions, SessionCallbacks } from './session-contract.js';
import { AsyncQueue } from './async-queue.js';
import { DraftBuffer } from './draft-buffer.js';
import { errorStep, infoStep } from './feed.js';
import * as gateActions from './gate-actions.js';
import type { RoutedMessage } from './message-router.js';
import { listCommands, listModels, maybeGenerateTitle, modelMatches, type ParityQuery } from './parity-controls.js';
import { TranscriptLog } from './transcript-log.js';
import { abandonRunningSteps, applyToolEvents, patchSubAgent } from './step-patcher.js';
import { describeAttachments } from './query-factory.js';
import { switchPermissionMode } from './permission-switch.js';
import { PromptQueue } from './prompt-queue.js';
import { SubAgentTracker } from './sub-agent-tracker.js';
import { buildSessionSummary } from './session-summary.js';
import { ToolTracker } from './tool-tracker.js';
import { TodoTracker } from './todo-tracker.js';
import { SessionRuntimeControls, type RuntimeControlQuery } from './session-runtime-controls.js';
import { rewindFiles, type RewindResult } from './file-checkpoints.js';
import * as operations from './session-operations.js';
import { createDriver, type SessionDriver } from './session-driver.js';

export type { LaunchOptions, SessionCallbacks } from './session-contract.js';

export class ClaudiaSession {
  readonly id = randomUUID();
  private readonly gate = new ApprovalGate();
  private readonly tools = new ToolTracker();
  private readonly todos = new TodoTracker();
  private input = new AsyncQueue<unknown>();
  private queryGen = 0; // Bumped on relaunch so outdated consume loops cannot mutate current state.
  private driver: SessionDriver | null = null;
  private state: SessionState = 'starting';
  private readonly startedAt = Date.now();
  private lastActivityAt = Date.now();
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
      controls: this.controls,
      todos: this.todos.todos,
    });
  }

  private get raw(): unknown {
    return this.driver?.raw ?? null;
  }

  /** For file-search.ts, which walks a plain directory and knows nothing about sessions. */
  get cwd(): string { return this.opts.cwd; }
  mcpStatus() { return operations.mcpStatus(this.raw as operations.OperationalQuery | null); }
  reconnectMcp(name: string) { return (this.raw as operations.OperationalQuery | null)?.reconnectMcpServer?.(name); }
  toggleMcp(name: string, enabled: boolean) { return (this.raw as operations.OperationalQuery | null)?.toggleMcpServer?.(name, enabled); }
  stopTask(taskId: string) { return (this.raw as operations.OperationalQuery | null)?.stopTask?.(taskId); }
  // Meaningless for Codex — .claude/settings.json has nothing to do with it.
  effectiveSettings() { return this.opts.agent === 'codex' ? Promise.resolve(null) : operations.resolvedSettings(this.opts.cwd); }

  start(): void {
    if (this.opts.prompt?.trim()) {
      this.firstPrompt = this.opts.prompt;
      this.beginDriver();
      this.driver?.sendPrompt(this.opts.prompt);
      const item: TranscriptItem = { ts: Date.now(), kind: 'user', text: this.opts.prompt };
      this.transcript.append(item);
      this.cb.onTranscript(this.id, item);
      this.awaitingFirstPrompt = false;
      return;
    }
    this.cb.onFeed(this.id, infoStep('Session ready', 'waiting for your first prompt'));
    this.setState('idle');
  }

  /**
   * The single place that knows how to construct this session's driver. Both
   * first start and a permission relaunch go through it, so the two cannot
   * drift apart on the settings they pass.
   */
  private makeDriver(mode: PermissionLaunchMode, resume: string | undefined, input: AsyncQueue<unknown>): SessionDriver {
    return createDriver({
      agent: this.opts.agent ?? 'claude',
      cwd: this.opts.cwd,
      model: this.opts.model,
      permissionMode: mode,
      effortLevel: this.controls.effortLevel,
      thinkingMode: this.controls.thinkingMode,
      resume,
      forkSession: this.opts.forkSession,
      input,
      gateCtx: this.gateCtx(),
    });
  }

  private beginDriver(): void {
    if (this.driver) return;
    this.driver = this.makeDriver(this.opts.permissionMode, this.opts.resume, this.input);
    this.controls.ensureOutputStyles(this.raw as RuntimeControlQuery | null, () => this.cb.onUpdate(this.summary()));
    void this.consume(this.queryGen);
  }

  private async consume(gen: number): Promise<void> {
    try {
      for await (const routed of this.driver as SessionDriver) {
        if (gen !== this.queryGen) return; // superseded mid-iteration
        this.applyRouted(routed);
      }
      if (gen !== this.queryGen) return;
      if (this.state !== 'error') this.setState('stopped');
    } catch (err) {
      if (gen !== this.queryGen) return;
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private applyRouted(routed: RoutedMessage): void {
    this.lastActivityAt = Date.now();

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
      this.todos.capture(item);
    }

    applyToolEvents(this.tools, routed, (stepId, patch) => this.cb.onFeedPatch(this.id, stepId, patch));

    if (routed.claudeSessionId) this.claudeSessionId = routed.claudeSessionId;
    if (routed.model) {
      this.model = routed.model;
      if (modelMatches(this.selectedModel, routed.model)) this.selectedModel = undefined;
    }
    if (routed.slashCommands) this.cb.onCommands(this.id, routed.slashCommands);
    if (routed.costUsd !== undefined) {
      this.costUsd = routed.costUsd;
      this.promptQueue.shift();
      maybeGenerateTitle(
        this.raw as ParityQuery | null,
        { generated: this.generatedTitle, custom: this.customTitle, firstPrompt: this.firstPrompt },
        (title) => {
          if (this.customTitle) return;
          this.generatedTitle = title;
          this.cb.onUpdate(this.summary());
        },
      );
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

  private gateCtx(): gateActions.GateCtx {
    return {
      gate: this.gate,
      feed: (step) => this.cb.onFeed(this.id, step),
      setState: (state) => this.setState(state),
      getQuestion: () => this.pendingQuestion,
      setQuestion: (question) => (this.pendingQuestion = question),
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
  alwaysAllowProject(requestId: string) { return gateActions.alwaysAllowProject(this.gateCtx(), requestId, this.opts.cwd); }

  rename(title: string): void {
    this.customTitle = title.trim() || undefined;
    this.cb.onUpdate(this.summary());
  }

  async switchModel(model: string): Promise<void> {
    const q = this.raw as ParityQuery | null;
    await q?.setModel?.(model).catch(() => undefined);
    this.selectedModel = model;
    this.cb.onFeed(this.id, infoStep('Model switched', `${model} — from the next turn`));
    this.cb.onUpdate(this.summary());
  }

  async setEffort(effortLevel: EffortLevel): Promise<void> {
    await this.controls.setEffort(this.raw as RuntimeControlQuery | null, effortLevel).catch(() => undefined);
    this.cb.onFeed(this.id, infoStep('Effort changed', effortLevel));
    this.cb.onUpdate(this.summary());
  }

  async setThinking(thinkingMode: ThinkingMode): Promise<void> {
    await this.controls.setThinking(this.raw as RuntimeControlQuery | null, thinkingMode).catch(() => undefined);
    this.cb.onFeed(this.id, infoStep('Thinking changed', thinkingMode));
    this.cb.onUpdate(this.summary());
  }

  async setOutputStyle(style: string): Promise<void> {
    await this.controls.setOutputStyle(this.raw as RuntimeControlQuery | null, style).catch(() => undefined);
    this.cb.onFeed(this.id, infoStep('Output style switched', `${style} — from the next turn`));
    this.cb.onUpdate(this.summary());
  }

  refreshContext(): void {
    if (this.controls.contextPending) return;
    if (!this.sendControlPrompt('/context')) return;
    this.controls.requestContext(() => undefined);
    this.cb.onUpdate(this.summary());
  }

  /** True while a turn is in flight, so destructive actions can refuse. */
  isBusy(): boolean {
    return this.state === 'working' || this.state === 'starting' || this.state === 'awaiting_approval';
  }

  /** Records what a completed file restore actually changed. */
  noteRewind(detail: string): void {
    this.cb.onFeed(this.id, infoStep('Files restored', detail));
  }

  /** Whether `/context` or `/cost` has a live driver to reach — a session with no query yet would otherwise SPAWN one just to answer this. Excludes Codex, which has no such slash commands. */
  canSendControlPrompt(): boolean {
    return this.driver !== null && this.opts.agent !== 'codex';
  }

  sendControlPrompt(text: string): boolean {
    if (!this.canSendControlPrompt()) return false;
    this.sendPrompt(text);
    return true;
  }

  models(): Promise<ModelChoice[]> {
    return listModels(this.raw as ParityQuery | null);
  }

  commands() {
    return listCommands(this.raw as ParityQuery | null);
  }

  sendPrompt(text: string, images: PromptImage[] = []): void {
    if (this.state === 'working' || this.state === 'awaiting_approval' || this.state === 'starting') {
      this.promptQueue.push(text);
    }
    this.awaitingFirstPrompt = false;
    this.needsAction = undefined;
    if (!this.firstPrompt) this.firstPrompt = text;
    this.beginDriver();
    this.driver?.sendPrompt(text, images);
    const item: TranscriptItem = { ts: Date.now(), kind: 'user', text: `${text}${describeAttachments(images)}` };
    this.transcript.append(item);
    this.cb.onTranscript(this.id, item);
    this.lastActivityAt = Date.now();
    this.cb.onFeed(this.id, infoStep('Prompt sent', text.length > 160 ? `${text.slice(0, 159)}…` : text));
    this.setState('working');
  }

  /**
   * See permission-switch.ts — tighten in place, loosen via relaunch. Codex's
   * `raw` is always falsy, so it takes the same "no live query" path as an
   * unstarted Claude session: mode recorded, no relaunch attempted.
   */
  setPermissionMode(mode: PermissionLaunchMode): Promise<'in-place' | 'relaunched' | 'unchanged'> {
    return switchPermissionMode(
      {
        getMode: () => this.opts.permissionMode,
        setMode: (m) => (this.opts.permissionMode = m),
        getQuery: () => this.raw,
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
          this.driver = this.makeDriver(m, resume, input);
          void this.consume(this.queryGen);
        },
      },
      mode,
    );
  }

  async interrupt(): Promise<void> {
    if (!this.driver) return;
    await this.driver.interrupt();
    this.cb.onFeed(this.id, infoStep('Interrupted'));
    this.setState('idle');
  }

  rewindFiles(checkpointId: string): Promise<RewindResult> {
    return rewindFiles(this.raw, checkpointId);
  }

  stop(): void {
    if (this.draft.clear()) this.cb.onDraft(this.id, null);
    this.gate.abandon('Session stopped');
    abandonRunningSteps(this.tools, this.subAgents, (id, p) => this.cb.onFeedPatch(this.id, id, p), 'session stopped');
    this.promptQueue.clear();
    this.input.close();
    this.driver?.close();
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

  private setState(state: SessionState): void {
    if (this.state === 'stopped' && state !== 'stopped') return;
    this.state = state;
    this.cb.onUpdate(this.summary());
  }
}
