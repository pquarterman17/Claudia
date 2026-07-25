import { query } from '@anthropic-ai/claude-agent-sdk';
import type { FeedStep, ModelUsage, PermissionLaunchMode, SessionState, SessionSummary } from '@claudia/shared';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { ApprovalGate, type PermissionResult } from './approval-gate.js';
import { AsyncQueue } from './async-queue.js';
import { approvalStep, errorStep, infoStep, summarizeToolInput } from './feed.js';
import { routeMessage } from './message-router.js';

export interface SessionCallbacks {
  onUpdate: (summary: SessionSummary) => void;
  onFeed: (sessionId: string, step: FeedStep) => void;
}

export interface LaunchOptions {
  cwd: string;
  prompt: string;
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

  constructor(
    private readonly opts: LaunchOptions,
    private readonly cb: SessionCallbacks,
  ) {
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
      errorMessage: this.errorMessage,
    };
  }

  start(): void {
    this.pushUserText(this.opts.prompt);
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
      if (this.state !== 'error') this.setState('stopped');
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private applyMessage(message: Record<string, unknown>): void {
    this.lastActivityAt = Date.now();
    const routed = routeMessage(message, this.turnStartedAt);

    for (const step of routed.steps) this.cb.onFeed(this.id, step);

    if (routed.claudeSessionId) this.claudeSessionId = routed.claudeSessionId;
    if (routed.model) this.model = routed.model;
    // Cost and usage are cumulative in the SDK's result message — assign, never add.
    if (routed.costUsd !== undefined) this.costUsd = routed.costUsd;
    if (routed.modelUsage) this.modelUsage = routed.modelUsage;
    if (routed.errorMessage) this.errorMessage = routed.errorMessage;

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
    this.cb.onFeed(this.id, approvalStep(toolName, summary));
    this.setState('awaiting_approval');
    return promise;
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
    this.cb.onFeed(this.id, infoStep('Denied', message ?? pending?.summary));
    this.setState('working');
    return true;
  }

  sendPrompt(text: string): void {
    this.pushUserText(text);
    this.lastActivityAt = Date.now();
    this.cb.onFeed(this.id, infoStep('Prompt sent', text.length > 160 ? `${text.slice(0, 159)}…` : text));
    if (this.state === 'idle') this.setState('working');
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
    this.cb.onFeed(this.id, errorStep('Session error', message));
    this.setState('error');
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
