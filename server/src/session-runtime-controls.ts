import type { ContextUsage, EffortLevel, OutputStyles, ThinkingMode, TranscriptItem } from '@claudia/shared';
import { parseContextReply } from './context-parser.js';
import { fetchOutputStyles, type OutputStyleQuery } from './output-style-controls.js';

const CONTEXT_REQUEST_TTL_MS = 5 * 60_000;

export interface RuntimeControlQuery extends OutputStyleQuery {
  applyFlagSettings?: (settings: {
    effortLevel?: EffortLevel;
    alwaysThinkingEnabled?: boolean;
    outputStyle?: string;
  }) => Promise<void>;
}

export class SessionRuntimeControls {
  effortLevel: EffortLevel;
  thinkingMode: ThinkingMode;
  contextUsage: ContextUsage | undefined;
  outputStyles: OutputStyles | undefined;
  private contextRequestedAt: number | undefined;
  private outputStylesRequested = false;

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

  /**
   * Fetches the current style and the full list once per session — most tiles
   * never open the picker, and the answer does not change on its own, so
   * there is nothing to gain from asking the CLI twice.
   */
  ensureOutputStyles(q: RuntimeControlQuery | null, apply: () => void): void {
    if (this.outputStyles || this.outputStylesRequested) return;
    this.outputStylesRequested = true;
    void fetchOutputStyles(q).then((styles) => {
      if (styles) {
        this.outputStyles = styles;
        apply();
      }
    });
  }

  /** Optimistic: the CLI applies the switch starting next turn, exactly like a
   * model change, so there is nothing to await here beyond the request itself. */
  async setOutputStyle(q: RuntimeControlQuery | null, style: string): Promise<void> {
    await q?.applyFlagSettings?.({ outputStyle: style });
    if (this.outputStyles) this.outputStyles = { ...this.outputStyles, current: style };
  }
}
