/**
 * Matches `tool_result` blocks back to the `tool_use` that produced them.
 *
 * Results do not arrive in call order — a fast Read can land before a slow Bash
 * issued before it — so a stack or a "most recent" guess would mislabel steps.
 * Matching on tool_use_id is the only correct approach.
 */
export interface ToolCompletion {
  stepId: string;
  durMs: number;
  isError: boolean;
}

export class ToolTracker {
  private pending = new Map<string, { stepId: string; startedAt: number }>();
  /**
   * Outlives `pending`, which is cleared on completion. A sub-agent's final
   * notification can arrive after its Task tool_result, so the step it belongs
   * to still has to be findable.
   */
  private stepByToolUse = new Map<string, string>();

  begin(toolUseId: string, stepId: string, now = Date.now()): void {
    this.pending.set(toolUseId, { stepId, startedAt: now });
    this.stepByToolUse.set(toolUseId, stepId);
  }

  /** The step a tool call belongs to, whether or not it has finished. */
  stepFor(toolUseId: string): string | undefined {
    return this.stepByToolUse.get(toolUseId);
  }

  /** Returns null for an unknown id — a result whose call we never saw. */
  complete(toolUseId: string, isError: boolean, now = Date.now()): ToolCompletion | null {
    const started = this.pending.get(toolUseId);
    if (!started) return null;
    this.pending.delete(toolUseId);
    return { stepId: started.stepId, durMs: Math.max(0, now - started.startedAt), isError };
  }

  /** Steps still running — used to mark them abandoned when a session stops. */
  outstanding(): string[] {
    return [...this.pending.values()].map((p) => p.stepId);
  }

  clear(): void {
    this.pending.clear();
    this.stepByToolUse.clear();
  }
}
