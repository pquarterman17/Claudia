import type { SubAgentRun } from '@claudia/shared';

/**
 * Sub-agent runs, keyed by the feed step of the Task call that spawned them.
 *
 * Kept apart from the session so the merge rule is testable on its own. That
 * rule is the fiddly part: progress messages carry usage but no final status,
 * and the completion notification carries status and a summary but no usage —
 * so a naive overwrite would zero the token count at the moment it matters.
 */
export class SubAgentTracker {
  private byStep = new Map<string, SubAgentRun[]>();

  /** Merges an update and returns the step's full list, or null if unchanged. */
  merge(stepId: string, update: Partial<SubAgentRun> & { taskId: string }): SubAgentRun[] {
    const existing = this.byStep.get(stepId) ?? [];
    const index = existing.findIndex((r) => r.taskId === update.taskId);
    const base: SubAgentRun = existing[index] ?? {
      taskId: update.taskId,
      agentType: 'agent',
      description: '',
      totalTokens: 0,
      toolUses: 0,
      durationMs: 0,
      status: 'running',
    };

    // Only fields this message actually carried may overwrite.
    const carried = Object.fromEntries(
      Object.entries(update).filter(([, value]) => value !== undefined),
    ) as Partial<SubAgentRun>;
    const merged: SubAgentRun = { ...base, ...carried };

    const next = index >= 0 ? existing.map((r, i) => (i === index ? merged : r)) : [...existing, merged];
    this.byStep.set(stepId, next);
    return next;
  }

  get(stepId: string): SubAgentRun[] {
    return this.byStep.get(stepId) ?? [];
  }

  /** Marks anything still running as failed — used when a session dies. */
  abandon(): Array<{ stepId: string; runs: SubAgentRun[] }> {
    const out: Array<{ stepId: string; runs: SubAgentRun[] }> = [];
    for (const [stepId, runs] of this.byStep) {
      if (!runs.some((r) => r.status === 'running')) continue;
      const next = runs.map((r) => (r.status === 'running' ? { ...r, status: 'error' as const } : r));
      this.byStep.set(stepId, next);
      out.push({ stepId, runs: next });
    }
    return out;
  }

  clear(): void {
    this.byStep.clear();
  }
}
