import type { HostPlatform, SessionSummary } from '@claudia/shared';

/**
 * Keyboard model, kept apart from the React wiring so the decisions are
 * testable without a DOM.
 */

export type ShortcutAction =
  | { kind: 'approve_oldest' }
  | { kind: 'focus_session'; index: number }
  | { kind: 'toggle_usage' };

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** Tag name of the focused element, so typing is never hijacked. */
  targetTag?: string;
}

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** ⌘ on macOS, Ctrl elsewhere — matching what each platform's users expect. */
export function modifierHeld(e: KeyEventLike, platform: HostPlatform | undefined): boolean {
  return platform === 'darwin' ? e.metaKey : e.ctrlKey;
}

export function modifierLabel(platform: HostPlatform | undefined): string {
  return platform === 'darwin' ? '⌘' : 'Ctrl';
}

/**
 * Resolves a keypress to an action, or null. Returns null while the user is
 * typing unless the chord uses the platform modifier — Enter in a prompt box
 * must send the prompt, not approve something on the other side of the screen.
 */
export function resolveShortcut(e: KeyEventLike, platform: HostPlatform | undefined): ShortcutAction | null {
  const mod = modifierHeld(e, platform);
  const typing = e.targetTag !== undefined && TYPING_TAGS.has(e.targetTag);
  if (!mod || e.altKey) return null;
  if (typing && e.key !== 'Enter') return null;

  if (e.key === 'Enter') return { kind: 'approve_oldest' };
  if (e.key === 'u') return { kind: 'toggle_usage' };

  if (/^[1-9]$/.test(e.key)) {
    return { kind: 'focus_session', index: Number(e.key) - 1 };
  }
  return null;
}

/**
 * The approval that has been waiting longest. Oldest-first is the fair order
 * and makes a repeated chord drain the queue predictably.
 */
export function oldestPendingApproval(sessions: SessionSummary[]): SessionSummary | undefined {
  return sessions
    .filter((s) => s.pendingApproval)
    .sort((a, b) => (a.pendingApproval?.requestedAt ?? 0) - (b.pendingApproval?.requestedAt ?? 0))[0];
}
