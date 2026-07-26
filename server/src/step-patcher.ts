import type { FeedStepPatch, SubAgentRun } from '@claudia/shared';
import type { SubAgentTracker } from './sub-agent-tracker.js';
import type { ToolTracker } from './tool-tracker.js';

type PatchFn = (stepId: string, patch: FeedStepPatch) => void;

/** Folds a sub-agent update into the Task step that spawned it. */
export function patchSubAgent(
  tools: ToolTracker,
  subAgents: SubAgentTracker,
  patch: PatchFn,
  toolUseId: string,
  run: Partial<SubAgentRun> & { taskId: string },
): void {
  const stepId = tools.stepFor(toolUseId);
  if (!stepId) return;
  patch(stepId, { subAgents: subAgents.merge(stepId, run) });
}

/**
 * Marks every still-running tool step and sub-agent as failed. Called when a
 * session dies or restarts — otherwise they spin forever in the feed.
 */
export function abandonRunningSteps(
  tools: ToolTracker,
  subAgents: SubAgentTracker,
  patch: PatchFn,
  reason: string,
): void {
  for (const stepId of tools.outstanding()) {
    patch(stepId, { status: 'error', meta: `did not finish — ${reason}` });
  }
  for (const { stepId, runs } of subAgents.abandon()) {
    patch(stepId, { subAgents: runs });
  }
  tools.clear();
}
