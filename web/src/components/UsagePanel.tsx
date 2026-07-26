import type { PlanTier, SessionSummary, UsageSnapshot, UsageWindow } from '@claudia/shared';
import { fmtTokens } from '../format';
import { send } from '../store';
import { COLORS } from '../status';

const TIERS: Array<{ key: PlanTier; label: string; title: string }> = [
  { key: 'auto', label: 'vs your history', title: 'Compare against a typical day for you — no invented ceilings' },
  { key: 'pro', label: 'Pro', title: 'Estimated Pro ceiling — unverified' },
  { key: 'max5x', label: 'Max 5x', title: 'Estimated Max 5x ceiling — unverified' },
  { key: 'max20x', label: 'Max 20x', title: 'Estimated Max 20x ceiling — unverified' },
  { key: 'custom', label: 'Custom', title: 'ceilings you set yourself' },
];

const LEVEL_COLOR = { ok: '#d2cefd', low: COLORS.warn, critical: COLORS.err } as const;
const LEVEL_BAR = {
  ok: 'linear-gradient(90deg,#5d5294,#9184d9)',
  low: 'linear-gradient(90deg,#6b5636,#d9b184)',
  critical: 'linear-gradient(90deg,#7a4646,#d98484)',
} as const;

interface Props {
  usage: UsageSnapshot;
  customCeilings?: { sessionTokens: number; weeklyTokens: number };
  sessions: SessionSummary[];
}

/**
 * `/cost` has to be sent to a live session, so a target has to be chosen.
 * An idle one is preferred — sending it to a session mid-turn still works
 * (the SDK just queues it) but delays the answer behind whatever it was
 * already doing.
 */
function pickCostTarget(sessions: SessionSummary[]): SessionSummary | undefined {
  return sessions.find((s) => s.state === 'idle') ?? sessions.find((s) => s.state !== 'stopped');
}

/**
 * Once usage passes the reference, "0% left" is both alarming and uninformative
 * — it cannot distinguish just-over from ten-times-over. Past that point report
 * the multiple instead, which is the number that actually tells you something.
 */
export function usageHeadline(w: UsageWindow): { value: string; suffix: string } {
  if (w.referenceTokens === null || w.remainingPct === null) return { value: '—', suffix: 'no baseline' };
  if (w.billableTokens > w.referenceTokens) {
    const ratio = w.billableTokens / w.referenceTokens;
    return { value: `${ratio.toFixed(1)}×`, suffix: 'typical' };
  }
  return { value: `${w.remainingPct}%`, suffix: 'left' };
}

/**
 * Plan usage from local session history, plus real usage when it has been
 * fetched via `/cost`. The history windows below are always an estimate —
 * no API exposes real allowances on its own — but `/cost` sent as a prompt
 * to a live session does, so the panel shows that instead whenever it has it.
 */
export function UsagePanel({ usage, customCeilings, sessions }: Props) {
  const sendCeilings = (session: number, weekly: number) =>
    send({ type: 'set_custom_ceilings', sessionTokens: session, weeklyTokens: weekly });
  const maxProject = Math.max(1, ...usage.byProject.map((p) => p.billableTokens));
  const costTarget = pickCostTarget(sessions);

  return (
    <div
      className="usage-panel"
      style={{
        flex: 'none',
        display: 'flex',
        gap: 34,
        alignItems: 'flex-start',
        padding: '16px 18px',
        borderBottom: '1px solid #2c2f3d',
        background: '#1c1e2b',
      }}
    >
      <div style={{ minWidth: 200 }}>
        <div className="kicker" style={{ marginBottom: 8 }}>
          Real plan limits
        </div>
        <button
          type="button"
          disabled={!costTarget || usage.realPending}
          onClick={() => costTarget && send({ type: 'fetch_real_usage', sessionId: costTarget.id })}
          title={
            costTarget
              ? `Sends /cost to "${costTarget.name}" — costs that session a few tokens and adds two lines to its transcript`
              : 'No live session to ask — launch one first'
          }
          style={{
            cursor: !costTarget || usage.realPending ? 'not-allowed' : 'pointer',
            borderRadius: 7,
            minHeight: 28,
            padding: '4px 10px',
            fontFamily: 'var(--font-body)',
            fontSize: 11.5,
            border: '1px solid #33364a',
            background: 'transparent',
            color: !costTarget ? '#595d6c' : '#9397ab',
            opacity: usage.realPending ? 0.6 : 1,
          }}
        >
          {usage.realPending ? 'asking the CLI…' : 'Refresh from /cost'}
        </button>

        {usage.real ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
            {usage.real.windows.map((w) => (
              <div key={w.label}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontSize: 11, color: '#9397ab' }}>{w.label}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: '#d2cefd' }}>
                    {w.usedPct}%
                  </span>
                </div>
                <div style={{ fontSize: 10, color: '#595d6c' }}>resets {w.resetsAt}</div>
              </div>
            ))}
            <div style={{ fontSize: 10, color: '#595d6c' }}>
              real, via {sessions.find((s) => s.id === usage.real?.sessionId)?.name ?? 'a session'} ·{' '}
              {new Date(usage.real.fetchedAt).toLocaleTimeString()}
            </div>
          </div>
        ) : (
          <p style={{ fontSize: 10.5, color: '#595d6c', marginTop: 8, lineHeight: 1.5 }}>
            {costTarget
              ? 'Not fetched yet — the windows below stay a local-history estimate until you ask the CLI directly.'
              : 'No live session to ask. Launch one, then refresh.'}
          </p>
        )}
      </div>

      <div style={{ minWidth: 260 }}>
        <div className="kicker" style={{ marginBottom: 8 }}>
          Measured against
        </div>
        <div role="group" aria-label="Usage comparison baseline" style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
          {TIERS.map((t) => {
            const on = usage.tier === t.key;
            return (
              <button
                key={t.key}
                type="button"
                aria-pressed={on}
                title={t.title}
                onClick={() => send({ type: 'set_plan_tier', tier: t.key })}
                style={{
                  cursor: 'pointer',
                  borderRadius: 7,
                  minHeight: 28, padding: '4px 10px',
                  fontFamily: 'var(--font-body)',
                  fontSize: 11.5,
                  border: `1px solid ${on ? '#796cbf' : '#33364a'}`,
                  background: on ? '#2b2741' : 'transparent',
                  color: on ? '#d2cefd' : '#9397ab',
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {usage.tier === 'custom' && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
            {(
              [
                { label: 'session', key: 'sessionTokens' as const },
                { label: 'weekly', key: 'weeklyTokens' as const },
              ]
            ).map((f) => (
              <label key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: '#9397ab' }}>
                {f.label}
                <input
                  type="number"
                  aria-label={`${f.label} token ceiling`}
                  min={1000}
                  step={100000}
                  className="input mono"
                  style={{ width: 110, fontSize: 11, padding: '3px 6px' }}
                  defaultValue={customCeilings?.[f.key] ?? ''}
                  placeholder="tokens"
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v) || v < 1000) return;
                    const next = { sessionTokens: customCeilings?.sessionTokens ?? v, weeklyTokens: customCeilings?.weeklyTokens ?? v, [f.key]: v };
                    sendCeilings(next.sessionTokens, next.weeklyTokens);
                  }}
                />
              </label>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
          {usage.windows.map((w) => (
            <div key={w.label}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: '#9397ab' }}>{w.label}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: LEVEL_COLOR[w.level] }}>
                  {usageHeadline(w).value}
                </span>
                <span style={{ fontSize: 10, color: '#595d6c' }}>{usageHeadline(w).suffix}</span>
              </div>
              <div style={{ height: 5, borderRadius: 3, background: '#2b2e3d', overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${w.remainingPct ?? 0}%`,
                    background: LEVEL_BAR[w.level],
                  }}
                />
              </div>
              <div style={{ fontSize: 10.5, color: '#595d6c', marginTop: 3 }}>
                {fmtTokens(w.billableTokens)}
                {w.referenceTokens !== null && ` vs ${fmtTokens(w.referenceTokens)} ${w.referenceLabel}`} ·{' '}
                {fmtTokens(w.tokens.outputTokens)} out
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="kicker" style={{ marginBottom: 10 }}>
          By project · last 7 days
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {usage.byProject.map((p) => (
            <div
              key={p.project}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0,150px) minmax(70px,1fr) 62px',
                gap: 10,
                alignItems: 'center',
              }}
            >
              <span
                className="mono"
                title={p.project}
                style={{
                  fontSize: 11.5,
                  color: '#cfd3e5',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {p.project}
              </span>
              <span style={{ height: 6, borderRadius: 3, background: '#26293a', overflow: 'hidden' }}>
                <span
                  style={{
                    display: 'block',
                    height: '100%',
                    width: `${Math.round((p.billableTokens / maxProject) * 100)}%`,
                    background: 'linear-gradient(90deg,#5d5294,#9184d9)',
                  }}
                />
              </span>
              <span
                style={{
                  fontSize: 11.5,
                  color: '#9397ab',
                  textAlign: 'right',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {fmtTokens(p.billableTokens)}
              </span>
            </div>
          ))}
          {usage.byProject.length === 0 && (
            <span style={{ fontSize: 11.5, color: '#595d6c' }}>
              {usage.scanning ? 'reading local session logs…' : 'no usage found in the last 7 days'}
            </span>
          )}
        </div>
      </div>

      <div style={{ width: 230 }}>
        <div className="kicker" style={{ marginBottom: 10 }}>
          By model
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {usage.byModel.map((m) => (
            <div key={m.model} style={{ display: 'flex', gap: 8, fontSize: 11.5 }}>
              <span
                className="mono"
                style={{
                  flex: 1,
                  minWidth: 0,
                  color: '#9397ab',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {m.model}
              </span>
              <span style={{ color: '#cfd3e5', fontVariantNumeric: 'tabular-nums' }}>
                {fmtTokens(m.billableTokens)}
              </span>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 10, color: '#595d6c', marginTop: 12, lineHeight: 1.5 }}>
          Counted from this machine's own session logs — terminal sessions included, other
          machines not.{' '}
          {usage.real
            ? 'Real plan allowance is shown on the left, fetched on demand via /cost — these windows stay a local-history estimate.'
            : 'No API reports real plan allowances on its own, so the default compares against a typical day of your own rather than inventing a ceiling.'}{' '}
          Cache reads are weighted at 10%, as billing does.
        </p>
      </div>
    </div>
  );
}
