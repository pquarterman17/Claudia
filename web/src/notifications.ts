import type { SessionSummary } from '@claudia/shared';

/**
 * Desktop notifications for sessions that need a human.
 *
 * The decision of *what* is worth interrupting for is a pure function, so the
 * awkward parts — not re-notifying for a state a session is already in, staying
 * quiet while you are looking at the window — are testable without a browser.
 */

export type Attention = 'awaiting_approval' | 'error' | 'question';

export interface AttentionEvent {
  sessionId: string;
  name: string;
  kind: Attention;
  detail: string;
}

/** Sessions that have *newly* entered a state needing a human. */
export function newlyNeedingAttention(
  previous: Map<string, string>,
  current: SessionSummary[],
): AttentionEvent[] {
  const events: AttentionEvent[] = [];
  for (const session of current) {
    // A question is keyed separately: the session sits in 'idle' while asking,
    // so watching state alone would never see it.
    const key = session.needsAction ? `asking:${session.needsAction.since}` : session.state;
    const was = previous.get(session.id);
    // Only the transition matters. Without this every poll would re-notify for
    // a session that is simply still waiting.
    if (was === key) continue;

    if (session.needsAction) {
      events.push({
        sessionId: session.id,
        name: session.name,
        kind: 'question',
        detail: session.needsAction.request,
      });
    } else if (session.state === 'awaiting_approval' && session.pendingApproval) {
      events.push({
        sessionId: session.id,
        name: session.name,
        kind: 'awaiting_approval',
        detail: `${session.pendingApproval.toolName}: ${session.pendingApproval.summary}`,
      });
    } else if (session.state === 'error') {
      events.push({
        sessionId: session.id,
        name: session.name,
        kind: 'error',
        detail: session.errorMessage ?? 'session failed',
      });
    }
  }
  return events;
}

/** Keyed by what matters for notifying, not by session state alone. */
export function stateMap(sessions: SessionSummary[]): Map<string, string> {
  return new Map(sessions.map((s) => [s.id, s.needsAction ? `asking:${s.needsAction.since}` : s.state]));
}

export function titleFor(event: AttentionEvent): string {
  if (event.kind === 'error') return `${event.name} — blocked`;
  if (event.kind === 'question') return `${event.name} — asked you a question`;
  return `${event.name} — needs approval`;
}

export const NOTIFY_KEY = 'claudia.notify.v1';

export function notificationsEnabled(): boolean {
  try {
    return localStorage.getItem(NOTIFY_KEY) === 'on';
  } catch {
    return false;
  }
}

export function setNotificationsEnabled(on: boolean): void {
  try {
    localStorage.setItem(NOTIFY_KEY, on ? 'on' : 'off');
  } catch {
    /* private mode; the toggle just won't persist */
  }
}

/** Permission must be requested from a user gesture, so this is called on click. */
export async function requestPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

export function canNotify(): boolean {
  return 'Notification' in window && Notification.permission === 'granted';
}

/**
 * Shows a notification unless the window is already focused — there is no point
 * interrupting someone with something they are looking at.
 */
export function notify(event: AttentionEvent, onClick: (sessionId: string) => void): void {
  if (!canNotify() || document.hasFocus()) return;
  const n = new Notification(titleFor(event), {
    body: event.detail,
    tag: `claudia-${event.sessionId}`, // replaces rather than stacks per session
  });
  n.onclick = () => {
    window.focus();
    onClick(event.sessionId);
    n.close();
  };
}
