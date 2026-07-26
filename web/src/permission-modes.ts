import type { PermissionLaunchMode } from '@claudia/shared';

/** UI copy for one permission mode — shared by the launch bar and per-session controls. */
export interface PermissionModeOption {
  key: PermissionLaunchMode;
  label: string;
  title: string;
  danger?: boolean;
}

/**
 * Every mode a session can launch or switch into, in the same order the
 * interactive CLI cycles them with Shift+Tab (default → accept edits → plan →
 * skip all). 'auto' leads since it is Claudia's own recommended default, not
 * part of that cycle.
 */
export const PERMISSION_MODES: PermissionModeOption[] = [
  { key: 'auto', label: 'Auto', title: 'Claude decides what genuinely needs asking' },
  { key: 'default', label: 'Ask each time', title: 'Prompt for anything not already allowlisted' },
  { key: 'acceptEdits', label: 'Accept edits', title: 'Edits apply without asking; commands still prompt' },
  {
    key: 'plan',
    label: 'Plan',
    title: 'Claude researches and proposes a plan — no edits, no commands run',
  },
  {
    key: 'bypassPermissions',
    label: 'Skip all',
    title: 'Every tool call runs unprompted — nothing will stop to ask you',
    danger: true,
  },
];

export const permissionModeLabel = (mode: PermissionLaunchMode): string =>
  PERMISSION_MODES.find((m) => m.key === mode)?.label ?? mode;
