import type { SessionSummary } from '@claudia/shared';
import { fmtCost, fmtTokens } from '../format';
import { COLORS } from '../status';

interface Props {
  sessions: SessionSummary[];
  connected: boolean;
}

/** Aggregate header: totals, status counts, connection state. */
export function TopBar({ sessions, connected }: Props) {
  const working = sessions.filter((s) => s.state === 'working' || s.state === 'starting').length;
  const waiting = sessions.filter((s) => s.state === 'awaiting_approval').length;
  const blocked = sessions.filter((s) => s.state === 'error').length;
  const idle = sessions.filter((s) => s.state === 'idle' || s.state === 'stopped').length;
  const cost = sessions.reduce((a, s) => a + s.costUsd, 0);
  const tokens = sessions.reduce((a, s) => a + s.inputTokens + s.outputTokens, 0);
  const total = sessions.length || 1;

  const segments = [
    { n: working, c: COLORS.accent },
    { n: waiting, c: COLORS.warn },
    { n: blocked, c: COLORS.err },
    { n: idle, c: '#3f424d' },
  ];

  return (
    <div className="topbar">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flex: 'none' }}>
        <span style={{ fontWeight: 500, fontSize: 15, letterSpacing: '-.01em' }}>Conductor</span>
        <span className="kicker">parallel claude code</span>
      </div>

      <div style={{ flex: 'none', display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 20, fontVariantNumeric: 'tabular-nums' }}>
          {idle} / {sessions.length}
        </span>
        <span style={{ fontSize: 11.5, color: '#9397ab' }}>settled</span>
      </div>

      <div style={{ flex: '0 1 240px', display: 'flex', height: 7, borderRadius: 4, overflow: 'hidden', background: '#26293a' }}>
        {segments.map((g, i) => (
          <span key={i} style={{ height: '100%', width: `${(g.n / total) * 100}%`, background: g.c }} />
        ))}
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {[
          { n: working, label: 'working', c: COLORS.accent },
          { n: waiting, label: 'awaiting', c: COLORS.warn },
          { n: blocked, label: 'blocked', c: COLORS.err },
          { n: idle, label: 'idle', c: '#3f424d' },
        ].map((g) => (
          <span key={g.label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#9397ab' }}>
            <span style={{ width: 6, height: 6, borderRadius: 2, background: g.c }} />
            {g.n} {g.label}
          </span>
        ))}
      </div>

      <div style={{ flex: 1 }} />

      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <Stat label="today" value={fmtCost(cost)} />
        <Stat label="tokens" value={fmtTokens(tokens)} />
        <span
          title={connected ? 'connected to server' : 'reconnecting…'}
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: connected ? COLORS.ok : COLORS.err,
            animation: connected ? 'none' : 'claudia-pulse 1.2s ease-in-out infinite',
          }}
        />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.1 }}>
      <span className="kicker" style={{ fontSize: 9 }}>
        {label}
      </span>
      <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </span>
  );
}
