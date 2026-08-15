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

/**
 * Folds one message's tool starts and completions into the feed.
 *
 * Kept here with the other step bookkeeping: a completed call has to find the
 * step its start created, which is exactly what the tracker's id map is for.
 */
export function applyToolEvents(
  tools: { begin: (toolUseId: string, stepId: string) => void; complete: (toolUseId: string, isError: boolean) => { stepId: string; durMs: number; isError: boolean } | null },
  routed: { toolStarts?: Array<{ toolUseId: string; stepId: string }>; toolEnds?: Array<{ toolUseId: string; isError: boolean }> },
  onPatch: (stepId: string, patch: { durMs: number; status: 'ok' | 'error' }) => void,
): void {
  for (const start of routed.toolStarts ?? []) tools.begin(start.toolUseId, start.stepId);
  for (const end of routed.toolEnds ?? []) {
    const done = tools.complete(end.toolUseId, end.isError);
    if (done) onPatch(done.stepId, { durMs: done.durMs, status: done.isError ? 'error' : 'ok' });
  }
}
