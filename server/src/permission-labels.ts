import type { PermissionLaunchMode } from '@claudia/shared';

/** Plain-English description of a permission mode, for the feed. */
export function describeMode(mode: PermissionLaunchMode): string {
  switch (mode) {
    case 'bypassPermissions':
      return 'permissions skipped — tools run without asking';
    case 'acceptEdits':
      return 'edits auto-accepted; commands still ask';
    case 'auto':
      return 'auto — Claude decides what needs asking';
    default:
      return 'approvals required';
  }
}
