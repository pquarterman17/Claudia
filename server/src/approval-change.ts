import type { ApprovalChange } from '@claudia/shared';

const PREVIEW_LIMIT = 1_000;

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function preview(value: string): { value: string; truncated: boolean } {
  return value.length > PREVIEW_LIMIT
    ? { value: `${value.slice(0, PREVIEW_LIMIT)}\n…`, truncated: true }
    : { value, truncated: false };
}

/**
 * Extract only the known mutation fields that are useful for a decision.
 * We intentionally never forward arbitrary tool input (commands, metadata or
 * credentials can live there); malformed inputs simply get no preview.
 */
export function approvalChange(toolName: string, input: Record<string, unknown>): ApprovalChange | undefined {
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
