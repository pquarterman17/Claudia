import type { FinishActionKey, SessionSummary, TriggerStatus } from '@claudia/shared';
import { useEffect, useState } from 'react';
import { send } from '../store';
import { COLORS } from '../status';

const ACTIONS: Array<{ key: FinishActionKey; label: string; unavailable?: string }> = [
  { key: 'notify', label: 'Notify me' },
  {
    key: 'commit',
    label: 'Commit + push all',
    // Offered by the design but not built: pushing unreviewed work needs
    // per-repo rules. Disabled rather than firing as a silent no-op.
    unavailable: 'Not implemented yet — would push unreviewed work',
  },
  { key: 'sleep', label: 'Sleep displays' },
  { key: 'shutdown', label: 'Shut down host' },
  { key: 'script', label: 'Run wrap-up script' },
];

interface Props {
  trigger: TriggerStatus;
  sessions: SessionSummary[];
  countdownSec: number;
}

/**
 * Global control: what happens when every session settles, and bulk actions.
 * The aggregate counts live in the top bar; this tile is the action surface.
 */
export function ControllerTile({ trigger, sessions, countdownSec }: Props) {
  const [confirming, setConfirming] = useState(false);
  const waiting = sessions.filter((s) => s.pendingApproval).length;
  const busy = sessions.filter((s) => s.state === 'working' || s.state === 'starting').length;
  const unprompted = sessions.filter((s) => s.permissionMode === 'bypassPermissions').length;
  const armed = trigger.state === 'armed' || trigger.state === 'counting';

  // A pending confirm must not survive switching to a different action.
  useEffect(() => setConfirming(false), [trigger.action, trigger.state]);

  const onArmClick = () => {
    if (armed) {
      send({ type: 'disarm_trigger' });
      return;
    }
    if (trigger.destructive && !confirming) {
      setConfirming(true);
      return;
    }
    send({ type: 'arm_trigger', confirmDestructive: trigger.destructive });
    setConfirming(false);
  };

  const armLabel = armed ? 'Disarm' : confirming ? 'Confirm — really?' : 'Arm';
  const armColor = confirming ? COLORS.err : armed ? COLORS.warn : '#b5abfc';

  return (
    <div
      className="tile"
      style={{
        borderColor: '#5d5294',
        background: 'linear-gradient(180deg,#1e1b2b,#191b28)',
      }}
    >
      <div className="tile-head" style={{ background: '#201d2e', borderBottomColor: '#423a6a' }}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: armed ? COLORS.warn : '#4a4e5e',
            animation: armed ? 'claudia-pulse 1.6s ease-in-out infinite' : 'none',
          }}
        />
        <span style={{ fontWeight: 500, fontSize: 13, color: '#d2cefd' }}>Claudia</span>
        <span style={{ flex: 1, fontSize: 10.5, color: '#75798c' }}>global control</span>
        <span style={{ fontSize: 10.5, color: armed ? COLORS.warn : COLORS.mute }}>{trigger.state}</span>
      </div>

      <div className="tile-body" style={{ background: 'transparent', gap: 12, justifyContent: 'flex-start' }}>
        {unprompted > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '7px 9px',
              border: '1px solid #5c3b3b',
              borderRadius: 7,
              background: '#2a2027',
            }}
          >
            <span style={{ color: COLORS.err, fontSize: 12 }}>⚠</span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: COLORS.warn }}>
              {unprompted} {unprompted === 1 ? 'session runs' : 'sessions run'} unprompted — every tool call
              executes without asking
            </span>
            <button
              className="btn btn-ghost"
              onClick={() => send({ type: 'require_approvals_everywhere' })}
              style={{ fontSize: 11, padding: '2px 8px', color: '#9397ab' }}
            >
              Require approvals
            </button>
          </div>
        )}

        <section>
          <div className="kicker" style={{ marginBottom: 6 }}>
            When everything finishes
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {ACTIONS.map((a) => {
              const on = trigger.action === a.key;
              const danger = a.key === 'shutdown';
              return (
                <button
                  key={a.key}
                  disabled={!!a.unavailable}
                  title={a.unavailable}
                  onClick={() => send({ type: 'select_finish_action', action: a.key })}
                  style={{
                    cursor: a.unavailable ? 'not-allowed' : 'pointer',
                    borderRadius: 7,
                    padding: '5px 10px',
                    fontFamily: 'var(--font-body)',
                    fontSize: 11.5,
                    whiteSpace: 'nowrap',
                    border: `1px solid ${on ? (danger ? '#8a4f4f' : '#796cbf') : '#33364a'}`,
                    background: on ? (danger ? '#2e2226' : '#2b2741') : 'transparent',
                    color: on ? (danger ? '#e0a0a0' : '#d2cefd') : '#9397ab',
                    textDecoration: a.unavailable ? 'line-through' : 'none',
                  }}
                >
                  {a.label}
                </button>
              );
            })}
          </div>
          <div
            className="mono"
            title={trigger.command}
            style={{
              marginTop: 6,
              fontSize: 10.5,
              color: trigger.destructive ? COLORS.err : '#595d6c',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {trigger.command}
          </div>
        </section>

        <section
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '9px 10px',
            borderRadius: 8,
            border: `1px solid ${confirming ? '#8a4f4f' : armed ? '#6b5636' : '#33364a'}`,
            background: armed ? '#251f2c' : '#1c1e2b',
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 12, color: armed ? COLORS.warn : COLORS.text }}>
              {statusTitle(trigger)}
            </span>
            <span style={{ display: 'block', fontSize: 11, color: '#75798c', marginTop: 2 }}>
              {statusSub(trigger)}
            </span>
          </span>
          {trigger.countdownSec !== undefined && (
            <span
              className="mono"
              style={{ fontSize: 20, color: COLORS.warn, fontVariantNumeric: 'tabular-nums' }}
            >
              {trigger.countdownSec}s
            </span>
          )}
          <button
            className="btn btn-primary"
            onClick={onArmClick}
            style={{ fontSize: 11.5, padding: '4px 12px', borderColor: armColor, color: armColor }}
          >
            {armLabel}
          </button>
        </section>

        <section style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="kicker">Grace period</span>
          <input
            type="number"
            min={5}
            max={600}
            value={countdownSec}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) send({ type: 'set_countdown', seconds: n });
            }}
            className="input mono"
            style={{ width: 62, fontSize: 11.5, padding: '3px 6px' }}
          />
          <span style={{ fontSize: 11, color: '#75798c' }}>
            seconds to cancel before it fires
          </span>
        </section>

        <section>
          <div className="kicker" style={{ marginBottom: 6 }}>
            Everything, at once
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <button
              className="btn btn-secondary"
              disabled={waiting === 0}
              onClick={() => send({ type: 'bulk', op: 'approve_all' })}
              style={{
                fontSize: 11.5,
                padding: '4px 10px',
                borderColor: '#3f424d',
                color: waiting ? '#d2cefd' : '#595d6c',
              }}
            >
              Approve all ({waiting})
            </button>
            <button
              className="btn btn-secondary"
              disabled={busy === 0}
              onClick={() => send({ type: 'bulk', op: 'interrupt_all' })}
              style={{
                fontSize: 11.5,
                padding: '4px 10px',
                borderColor: '#3f424d',
                color: busy ? '#9397ab' : '#595d6c',
              }}
            >
              Interrupt all ({busy})
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function statusTitle(t: TriggerStatus): string {
  const label = ACTIONS.find((a) => a.key === t.action)?.label ?? t.action;
  if (t.state === 'fired') return `${label} — fired`;
  if (t.state === 'counting') return `${label} in a moment`;
  if (t.state === 'armed') return `Armed · ${label}`;
  return `${label} when idle`;
}

function statusSub(t: TriggerStatus): string {
  if (t.state === 'fired') return t.lastResult ?? 'done';
  if (t.blockedBy && t.state === 'armed') return `held — ${t.blockedBy}`;
  if (t.state === 'armed') return 'fires once every session reports idle';
  if (t.state === 'counting') return 'cancel by disarming, or by starting work';
  return 'nothing fires until you arm it';
}
