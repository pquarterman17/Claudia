import type { SessionSummary } from '@claudia/shared';

export function orderSessions(sessions: SessionSummary[], attentionFirst: boolean): SessionSummary[] {
  return [...sessions].sort((a, b) => {
    if (attentionFirst) {
      const attention = attentionRank(a) - attentionRank(b);
      if (attention !== 0) return attention;
    }
    return a.startedAt - b.startedAt;
  });
}

function attentionRank(session: SessionSummary): number {
  if (session.pendingApproval || session.pendingQuestion || session.needsAction) return 0;
  if (session.state === 'error') return 1;
  if (session.state === 'working' || session.state === 'starting') return 2;
  return 3;
}
