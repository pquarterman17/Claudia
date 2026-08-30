import type { ApprovalChange } from '@claudia/shared';

const PREVIEW_LIMIT = 1_000;
// A plan is prose meant to be read in full, not a diff preview — bound it far
// more generously so a real plan (the first one probed ran 1140 chars) never
// gets cut off mid-sentence.
const PLAN_PREVIEW_LIMIT = 20_000;

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function preview(value: string, limit: number = PREVIEW_LIMIT): { value: string; truncated: boolean } {
  return value.length > limit
    ? { value: `${value.slice(0, limit)}\n…`, truncated: true }
    : { value, truncated: false };
}

/**
 * Extract only the known mutation fields that are useful for a decision.
 * We intentionally never forward arbitrary tool input (commands, metadata or
 * credentials can live there); malformed inputs simply get no preview.
 */
export function approvalChange(toolName: string, input: Record<string, unknown>): ApprovalChange | undefined {
  // Checked first, deliberately: ExitPlanMode's input is `{ plan, planFilePath }`
  // with no `file_path`, so this must not sit below the file_path bail-out.
  if (toolName === 'ExitPlanMode') {
    const plan = text(input['plan']);
    const planFilePath = text(input['planFilePath']);
    if (plan === undefined || planFilePath === undefined) return undefined;
    const planPreview = preview(plan, PLAN_PREVIEW_LIMIT);
    return { kind: 'plan', plan: planPreview.value, planFilePath, truncated: planPreview.truncated };
  }

  const path = text(input['file_path']);
  if (!path) return undefined;

  if (toolName === 'Edit') {
    const before = text(input['old_string']);
    const after = text(input['new_string']);
    if (before === undefined || after === undefined) return undefined;
    const oldPreview = preview(before);
    const newPreview = preview(after);
    return {
      kind: 'edit', path, before: oldPreview.value, after: newPreview.value,
      truncated: oldPreview.truncated || newPreview.truncated,
    };
  }
  if (toolName === 'Write') {
    const content = text(input['content']);
    if (content === undefined) return undefined;
    const next = preview(content);
    return { kind: 'write', path, after: next.value, truncated: next.truncated };
  }
  return undefined;
}
