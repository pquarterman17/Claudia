import type { SessionSummary } from '@claudia/shared';
import { fmtTokens } from '../format';
import { send } from '../store';

export function ContextMeter({ session }: { session: SessionSummary }) {
  const usage = session.contextUsage;
  const color = !usage ? '#75798c' : usage.usedPct >= 90 ? '#e08d8d' : usage.usedPct >= 80 ? '#d9b184' : '#8fc9ad';
  return (
    <button
      type="button"
      className="btn btn-ghost"
      disabled={session.contextPending}
      onClick={() => send({ type: 'refresh_context', sessionId: session.id })}
      title={usage ? `${fmtTokens(usage.usedTokens)} of ${fmtTokens(usage.maxTokens)} used · refresh with /context` : 'Measure the real context window with /context'}
      style={{ flex: 'none', minHeight: 28, padding: '1px 7px', fontSize: 9.5, color }}
    >
      {session.contextPending ? 'Context…' : usage ? `Context ${usage.usedPct}%` : 'Check context'}
    </button>
  );
}
