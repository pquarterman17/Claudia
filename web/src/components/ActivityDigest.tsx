import type { FeedStep, SessionSummary } from '@claudia/shared';
import { elapsed, fmtCost, fmtTokens } from '../format';
import { COLORS, statusOf } from '../status';

interface Props {
  sessions: SessionSummary[];
  feeds: Record<string, FeedStep[]>;
  now: number;
}

/**
 * The "what is happening right now" summary for the side panel.
 *
 * One line per session showing the thing it is currently doing, so the whole
 * board can be read without visiting each tile — the reason the panel is
 * full-height rather than a tile in the grid.
 */
export function ActivityDigest({ sessions, feeds, now }: Props) {
  if (sessions.length === 0) {
    return (
      <section>
        <div className="kicker" style={{ marginBottom: 6 }}>
          Right now
        </div>
        <div style={{ fontSize: 11, color: '#595d6c' }}>No sessions yet.</div>
      </section>
    );
  }

  const ordered = [...sessions].sort((a, b) => rank(a) - rank(b) || a.startedAt - b.startedAt);
  const totalCost = sessions.reduce((a, s) => a + s.costUsd, 0);
  const totalTokens = sessions.reduce((a, s) => a + s.inputTokens + s.outputTokens, 0);

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span className="kicker">Right now</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: '#595d6c', fontVariantNumeric: 'tabular-nums' }}>
          {fmtCost(totalCost)} · {fmtTokens(totalTokens)}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {ordered.map((session) => {
          const status = statusOf(session.state);
          return (
            <button
              key={session.id}
              onClick={() => document.getElementById(`session-${session.id}`)?.scrollIntoView({ block: 'nearest' })}
              title="Jump to this session"
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                cursor: 'pointer',
                border: 0,
                background: 'transparent',
                padding: 0,
                fontFamily: 'var(--font-body)',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: status.dot,
                    flex: 'none',
                    animation: status.pulse ? 'claudia-pulse 1.6s ease-in-out infinite' : 'none',
                  }}
                />
                <span
                  style={{
                    fontSize: 11.5,
                    color: '#cfd3e5',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {session.name}
                </span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 10, color: '#595d6c', fontVariantNumeric: 'tabular-nums' }}>
                  {elapsed(session.lastActivityAt, now)}
                </span>
              </span>
              <span
                style={{
                  display: 'block',
                  fontSize: 10.5,
                  color: session.pendingApproval ? COLORS.warn : '#75798c',
                  marginLeft: 12,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {describe(session, feeds[session.id])}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** Sessions needing a human sort to the top; that is what the digest is for. */
function rank(s: SessionSummary): number {
  if (s.pendingApproval) return 0;
  if (s.state === 'error') return 1;
  if (s.state === 'working' || s.state === 'starting') return 2;
  return 3;
}

function describe(session: SessionSummary, feed: FeedStep[] | undefined): string {
  if (session.pendingApproval) return `needs you — ${session.pendingApproval.summary}`;
  if (session.state === 'error') return session.errorMessage ?? 'errored';
  if (session.state === 'stopped') return 'stopped';

  const last = [...(feed ?? [])].reverse().find((s) => s.kind !== 'info');
  if (session.state === 'working' || session.state === 'starting') {
    const running = [...(feed ?? [])].reverse().find((s) => s.status === 'running');
    if (running) return `${running.title}${running.meta ? ` — ${running.meta}` : ''}`;
    return last?.title ?? 'working…';
  }
  return last ? `done — ${last.title}` : 'idle, waiting for a prompt';
}
