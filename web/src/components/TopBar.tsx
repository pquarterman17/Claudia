import type { SessionSummary, UsageSnapshot } from '@claudia/shared';
import { useState } from 'react';
import { canNotify, notificationsEnabled, requestPermission, setNotificationsEnabled } from '../notifications';
import { fmtCost, fmtTokens } from '../format';
import { COLORS } from '../status';

interface Props {
  sessions: SessionSummary[];
  connected: boolean;
  usage?: UsageSnapshot;
  usageOpen: boolean;
  onToggleUsage: () => void;
}

/** Aggregate header: totals, status counts, plan headroom, connection state. */
export function TopBar({ sessions, connected, usage, usageOpen, onToggleUsage }: Props) {
  const working = sessions.filter((s) => s.state === 'working' || s.state === 'starting').length;
  const waiting = sessions.filter((s) => s.state === 'awaiting_approval' || s.needsAction).length;
  const blocked = sessions.filter((s) => s.state === 'error').length;
  const idle = sessions.filter(
    (s) => (s.state === 'idle' || s.state === 'stopped') && !s.needsAction,
  ).length;
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
        <span style={{ fontWeight: 500, fontSize: 15, letterSpacing: '-.01em' }}>Claudia</span>
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
          { n: waiting, label: 'need you', c: COLORS.warn },
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
        <button
          type="button"
          aria-pressed={usageOpen}
          aria-label="Toggle usage panel"
          onClick={onToggleUsage}
          title="Plan usage, estimated from local session history"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            cursor: 'pointer',
            border: `1px solid ${usageOpen ? '#5d5294' : '#33364a'}`,
            background: usageOpen ? '#2b2741' : '#1e2130',
            borderRadius: 8,
            padding: '5px 11px',
            color: 'var(--color-text)',
            fontFamily: 'var(--font-body)',
          }}
        >
          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.1 }}>
            <span className="kicker" style={{ fontSize: 9 }}>
              usage
            </span>
            <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: tightColor(usage) }}>
              {tightPct(usage)}
            </span>
          </span>
        </button>
        <NotifyToggle />
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

/** The tightest window with a reference is the one worth showing in the header. */
function tightest(usage?: UsageSnapshot) {
  const measured = usage?.windows.filter((w) => w.remainingPct !== null) ?? [];
  if (measured.length === 0) return undefined;
  return measured.reduce((a, w) => ((w.remainingPct ?? 100) < (a.remainingPct ?? 100) ? w : a));
}

function tightPct(usage?: UsageSnapshot): string {
  const w = tightest(usage);
  if (!w || w.referenceTokens === null) return '—';
  // Over the reference, the multiple is the informative number, not "0%".
  if (w.billableTokens > w.referenceTokens) return `${(w.billableTokens / w.referenceTokens).toFixed(1)}×`;
  return `${w.remainingPct}%`;
}

function tightColor(usage?: UsageSnapshot): string {
  const w = tightest(usage);
  if (!w) return COLORS.mute;
  return w.level === 'critical' ? COLORS.err : w.level === 'low' ? COLORS.warn : '#d2cefd';
}

/**
 * Desktop-notification switch. Permission can only be requested from a user
 * gesture, so turning it on is what asks the browser.
 */
function NotifyToggle() {
  const [on, setOn] = useState(() => notificationsEnabled() && canNotify());
  const [denied, setDenied] = useState(
    () => typeof Notification !== 'undefined' && Notification.permission === 'denied',
  );

  const toggle = async () => {
    if (on) {
      setNotificationsEnabled(false);
      setOn(false);
      return;
    }
    const granted = await requestPermission();
    if (!granted) {
      setDenied(true);
      return;
    }
    setNotificationsEnabled(true);
    setOn(true);
  };

  return (
    <button
      onClick={() => void toggle()}
      title={
        denied
          ? 'Your browser has blocked notifications for this site'
          : on
            ? 'Notifying when a session needs you — click to turn off'
            : 'Get notified when a session needs approval or errors'
      }
      style={{
        cursor: denied ? 'not-allowed' : 'pointer',
        border: `1px solid ${on ? '#796cbf' : '#33364a'}`,
        background: on ? '#2b2741' : 'transparent',
        borderRadius: 8,
        padding: '5px 9px',
        fontFamily: 'var(--font-body)',
        fontSize: 11,
        color: denied ? '#595d6c' : on ? '#d2cefd' : '#9397ab',
      }}
    >
      {denied ? 'notify blocked' : on ? 'notify on' : 'notify off'}
    </button>
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
