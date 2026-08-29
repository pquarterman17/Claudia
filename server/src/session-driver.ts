import type { AgentKind, EffortLevel, PermissionLaunchMode, PromptImage, ThinkingMode } from '@claudia/shared';
import type { AsyncQueue } from './async-queue.js';
import { CodexDriver, decideCodexApproval } from './codex-driver.js';
import * as gateActions from './gate-actions.js';
import { routeMessage, type RoutedMessage } from './message-router.js';
import { createSessionQuery, userMessage } from './query-factory.js';

/**
 * What a session needs from whichever agent backs it.
 *
 * ClaudiaSession owns the state machine, feed, transcript, approval gate,
 * prompt queue and todo tracker — none of that is Claude-specific. A driver's
 * only job is to speak its agent's wire protocol and hand back the same
 * RoutedMessage shape message-router.ts already produces for Claude, which is
 * what lets one session class run either agent.
 */
export interface SessionDriver extends AsyncIterable<RoutedMessage> {
  sendPrompt(text: string, images?: PromptImage[]): void;
  /** Cancels the in-flight turn, if the agent supports it. No-ops otherwise. */
  interrupt(): Promise<void>;
  /** Tears down the underlying process/connection. */
  close(): void;
  /**
   * The agent-specific query/client, for the handful of operations (models,
   * mcp status, rewind, permission mode…) that only make sense for one agent.
   * Callers narrow it with `as X | null`, exactly as they already did with
   * the raw SDK query object — an agent that doesn't implement an operation
   * degrades to "unsupported" for free, with no per-operation branching here.
   */
  readonly raw: unknown;
}

export interface DriverSpec {
  agent: AgentKind;
  cwd: string;
  model?: string;
  permissionMode: PermissionLaunchMode;
  effortLevel: EffortLevel;
  thinkingMode: ThinkingMode;
  resume?: string;
  forkSession?: boolean;
  input: AsyncQueue<unknown>;
  gateCtx: gateActions.GateCtx;
}

/** The one place a driver is constructed, so launch and relaunch cannot pick different agents. */
export function createDriver(spec: DriverSpec): SessionDriver {
  if (spec.agent === 'codex') {
    return new CodexDriver({
      cwd: spec.cwd,
      resume: spec.resume,
      permissionMode: spec.permissionMode,
      model: spec.model,
      onApproval: (approval) => decideCodexApproval(spec.gateCtx, approval),
    });
  }
  return new ClaudeDriver(spec);
}

/** Wraps `createSessionQuery` + `routeMessage`, the machinery Claudia was built around. */
class ClaudeDriver implements SessionDriver {
  private turnStartedAt = Date.now();
  private sessionId: string | undefined;
  private readonly input: AsyncQueue<unknown>;
  private readonly q: ReturnType<typeof createSessionQuery>;

  constructor(spec: DriverSpec) {
    this.input = spec.input;
    this.q = createSessionQuery({
      cwd: spec.cwd,
      model: spec.model,
      permissionMode: spec.permissionMode,
      effortLevel: spec.effortLevel,
      thinkingMode: spec.thinkingMode,
      resume: spec.resume,
      forkSession: spec.forkSession,
      input: spec.input,
      onPermission: (toolName, toolInput) => gateActions.openPermissionRequest(spec.gateCtx, toolName, toolInput),
    });
  }

  get raw(): unknown {
    return this.q;
  }

  sendPrompt(text: string, images: PromptImage[] = []): void {
    this.turnStartedAt = Date.now();
    this.input.push(userMessage(text, this.sessionId, images));
  }

  async interrupt(): Promise<void> {
    const q = this.q as { interrupt?: () => Promise<unknown> };
    await q.interrupt?.().catch(() => undefined);
  }

  close(): void {
    try {
      (this.q as { close?: () => void }).close?.();
    } catch {
      /* already closed */
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<RoutedMessage> {
    for await (const message of this.q as AsyncIterable<Record<string, unknown>>) {
      const routed = routeMessage(message, this.turnStartedAt);
      if (routed.claudeSessionId) this.sessionId = routed.claudeSessionId;
      yield routed;
    }
  }
}
