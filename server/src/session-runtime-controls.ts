import type { ContextUsage, EffortLevel, ThinkingMode, TranscriptItem } from '@claudia/shared';
import { parseContextReply } from './context-parser.js';

const CONTEXT_REQUEST_TTL_MS = 5 * 60_000;

export interface RuntimeControlQuery {
  applyFlagSettings?: (settings: {
    effortLevel?: EffortLevel;
    alwaysThinkingEnabled?: boolean;
  }) => Promise<void>;
}

export class SessionRuntimeControls {
  effortLevel: EffortLevel;
  thinkingMode: ThinkingMode;
  contextUsage: ContextUsage | undefined;
  private contextRequestedAt: number | undefined;

  constructor(effortLevel: EffortLevel = 'high', thinkingMode: ThinkingMode = 'adaptive') {
    this.effortLevel = effortLevel;
    this.thinkingMode = thinkingMode;
  }

  get contextPending(): boolean {
    return this.contextRequestedAt !== undefined && Date.now() - this.contextRequestedAt < CONTEXT_REQUEST_TTL_MS;
  }

  requestContext(send: () => void): void {
    this.contextRequestedAt = Date.now();
    send();
  }

  capture(item: TranscriptItem): boolean {
    if (item.kind !== 'assistant' || !this.contextPending) return false;
    const parsed = parseContextReply(item.text);
    if (!parsed) return false;
    this.contextUsage = parsed;
    this.contextRequestedAt = undefined;
    return true;
  }

  async setEffort(q: RuntimeControlQuery | null, effortLevel: EffortLevel): Promise<void> {
    await q?.applyFlagSettings?.({ effortLevel });
    this.effortLevel = effortLevel;
  }

  async setThinking(q: RuntimeControlQuery | null, thinkingMode: ThinkingMode): Promise<void> {
    await q?.applyFlagSettings?.({ alwaysThinkingEnabled: thinkingMode !== 'disabled' });
    this.thinkingMode = thinkingMode;
  }
}
